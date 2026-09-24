import { createHash } from 'node:crypto'

/**
 * What package.json says about who makes DBison and how to support it. The
 * build reads it in two places, `forge.config.js` (installer and binary
 * metadata) and `nuxt.config.ts` (the About and Support dialogs), and both go
 * through here so they cannot read it differently. Build-time only: the
 * renderer receives the results through runtime config.
 */

/**
 * The author, from npm's `Name <email> (url)` string or its object form.
 * @returns {{ name: string, email: string | null }}
 */
export function parseAuthor(author) {
  if (author && typeof author === 'object') {
    return {
      name: String(author.name ?? '').trim(),
      email: author.email ? String(author.email).trim() : null,
    }
  }

  const match = /^\s*([^<(]*?)\s*(?:<([^>]+)>)?\s*(?:\(([^)]+)\))?\s*$/.exec(String(author ?? ''))
  return { name: match?.[1] ?? '', email: match?.[2]?.trim() || null }
}

const text = (value) => (typeof value === 'string' ? value.trim() : '')

/**
 * The Ko-fi page, from a username ("dbison") or the page's URL. Anything else
 * is ignored rather than opened: the button hands this URL to the browser.
 */
function kofiUrl(value) {
  const input = text(value)
  if (/^[A-Za-z0-9_]{1,64}$/.test(input)) return `https://ko-fi.com/${input}`

  const match = /^https:\/\/(?:www\.)?ko-fi\.com\/([A-Za-z0-9_]{1,64})\/?$/i.exec(input)
  return match ? `https://ko-fi.com/${match[1]}` : null
}

// GitHub's own rule for user and organisation names: alphanumerics and single
// hyphens, not at either end, at most 39 characters.
const GITHUB_NAME = '[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}'

/**
 * The GitHub Sponsors page, from a username ("janvorisek") or the page's URL.
 * Anything else is ignored, for the same reason as `kofiUrl`.
 */
function githubSponsorsUrl(value) {
  const input = text(value)
  if (new RegExp(`^${GITHUB_NAME}$`).test(input)) return `https://github.com/sponsors/${input}`

  const match = new RegExp(`^https://github\\.com/sponsors/(${GITHUB_NAME})/?$`, 'i').exec(input)
  return match ? `https://github.com/sponsors/${match[1]}` : null
}

/**
 * The public source repository as a browsable https://github.com URL, from
 * package.json's `repository` in any of npm's forms (`owner/repo`,
 * `github:owner/repo`, a git URL, or an object with `url`), or null when it
 * names nothing on GitHub. The About dialog links to it, as the AGPL expects
 * a program's users to be told where its source is.
 * @returns {string | null}
 */
export function sourceUrl(pkg) {
  const repository = pkg?.repository
  const input = text(typeof repository === 'object' && repository ? repository.url : repository)
  const match = new RegExp(
    `^(?:github:|(?:git\\+)?https://github\\.com/|git@github\\.com:)?(${GITHUB_NAME})/([A-Za-z0-9._-]+?)(?:\\.git)?/?$`,
  ).exec(input)
  return match ? `https://github.com/${match[1]}/${match[2]}` : null
}

// --- Bitcoin addresses -------------------------------------------------------
//
// A mistyped address sends money nowhere, so a Bitcoin address in package.json
// is checked against its own checksum before it can reach a build: bech32 and
// bech32m for bc1… addresses (BIP 173, BIP 350), Base58Check for the older
// 1… and 3… ones.

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const BECH32_CONST = 1
const BECH32M_CONST = 0x2bc830a3

function bech32Polymod(values) {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let checksum = 1
  for (const value of values) {
    const top = checksum >>> 25
    checksum = ((checksum & 0x1ffffff) << 5) ^ value
    for (let bit = 0; bit < 5; bit++) {
      if ((top >>> bit) & 1) checksum ^= generators[bit]
    }
  }
  return checksum >>> 0
}

function convertBits(data, from, to) {
  let accumulator = 0
  let bits = 0
  const result = []
  for (const value of data) {
    accumulator = (accumulator << from) | value
    bits += from
    while (bits >= to) {
      bits -= to
      result.push((accumulator >>> bits) & ((1 << to) - 1))
    }
  }
  // Leftover bits must be padding: fewer than a group, and all zero.
  if (bits >= from || ((accumulator << (to - bits)) & ((1 << to) - 1))) return null
  return result
}

function isSegwitAddress(address) {
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) return false
  const lower = address.toLowerCase()
  if (!lower.startsWith('bc1') || lower.length < 14 || lower.length > 90) return false

  const data = [...lower.slice(3)].map((char) => BECH32_CHARSET.indexOf(char))
  if (data.length < 7 || data.includes(-1)) return false

  const hrp = [...'bc'].map((char) => char.charCodeAt(0))
  const expanded = [...hrp.map((c) => c >> 5), 0, ...hrp.map((c) => c & 31), ...data]
  const constant = bech32Polymod(expanded)
  if (constant !== BECH32_CONST && constant !== BECH32M_CONST) return false

  const [version, ...rest] = data.slice(0, -6)
  const program = convertBits(rest, 5, 8)
  if (!program || program.length < 2 || program.length > 40 || version > 16) return false
  // Version 0 is bech32 with a 20- or 32-byte program; later versions are bech32m.
  if (version === 0) return constant === BECH32_CONST && (program.length === 20 || program.length === 32)
  return constant === BECH32M_CONST
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function isBase58Address(address) {
  if (!/^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(address)) return false

  let number = 0n
  for (const char of address) number = number * 58n + BigInt(BASE58.indexOf(char))
  const bytes = []
  while (number > 0n) {
    bytes.unshift(Number(number % 256n))
    number /= 256n
  }
  const leadingZeros = address.length - address.replace(/^1+/, '').length
  const decoded = Buffer.from([...Array(leadingZeros).fill(0), ...bytes])
  if (decoded.length !== 25 || (decoded[0] !== 0x00 && decoded[0] !== 0x05)) return false

  const sha256 = (buffer) => createHash('sha256').update(buffer).digest()
  return sha256(sha256(decoded.subarray(0, 21))).subarray(0, 4).equals(decoded.subarray(21))
}

/** Whether a string is a valid Bitcoin mainnet address, checksum included. */
export function isValidBitcoinAddress(address) {
  const input = text(address)
  return isSegwitAddress(input) || isBase58Address(input)
}

/**
 * The ways to support DBison that are actually set up, from package.json's
 * `support` field.
 *
 * `github` is the GitHub Sponsors page and `kofi` the Ko-fi page, both opened
 * in the browser; Ko-fi takes one-off tips of any amount and monthly support,
 * GitHub Sponsors monthly or one-time sponsorships. Each crypto
 * entry needs its network as well as its address, because coins sent over
 * the wrong network are lost. An entry left empty is skipped, so the
 * placeholders in package.json show up as "coming soon" until filled in; a
 * Bitcoin address that fails its checksum stops the build instead.
 *
 * Bitcoin entries also get a BIP 21 `bitcoin:` link, which the Support dialog
 * puts in its QR code and hands to a wallet app.
 * @returns {{ github: string | null, kofi: string | null, crypto: { name: string, network: string, address: string, uri: string | null }[] }}
 */
export function supportOptions(pkg) {
  const support = pkg?.support ?? {}

  const crypto = (Array.isArray(support.crypto) ? support.crypto : [])
    .map((entry) => ({ name: text(entry?.name), network: text(entry?.network), address: text(entry?.address) }))
    .filter((entry) => entry.name && entry.network && entry.address)
    .map((entry) => {
      if (entry.network.toLowerCase() !== 'bitcoin') return { ...entry, uri: null }
      if (!isValidBitcoinAddress(entry.address)) {
        throw new Error(`package.json support.crypto: "${entry.address}" is not a valid Bitcoin address (checksum failed)`)
      }
      return { ...entry, uri: `bitcoin:${entry.address}` }
    })

  return { github: githubSponsorsUrl(support.github), kofi: kofiUrl(support.kofi), crypto }
}
