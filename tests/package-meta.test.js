import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { isValidBitcoinAddress, parseAuthor, sourceUrl, supportOptions } from '../shared/package-meta.js'

describe('parseAuthor', () => {
  it('reads npm\'s author string', () => {
    expect(parseAuthor('Jan Vorisek <jan@vorisek.me>')).toEqual({ name: 'Jan Vorisek', email: 'jan@vorisek.me' })
  })

  it('ignores a trailing url and tolerates a missing email', () => {
    expect(parseAuthor('Jan Vorisek <jan@vorisek.me> (https://example.com)'))
      .toEqual({ name: 'Jan Vorisek', email: 'jan@vorisek.me' })
    expect(parseAuthor('Jan Vorisek')).toEqual({ name: 'Jan Vorisek', email: null })
  })

  it('reads the object form and survives nothing at all', () => {
    expect(parseAuthor({ name: ' Jan Vorisek ', email: 'jan@vorisek.me' }))
      .toEqual({ name: 'Jan Vorisek', email: 'jan@vorisek.me' })
    expect(parseAuthor(undefined)).toEqual({ name: '', email: null })
  })
})

describe('isValidBitcoinAddress', () => {
  it('accepts every mainnet address type', () => {
    // P2PKH (the genesis block's), P2SH, P2WPKH (BIP 173), P2TR (BIP 350).
    for (const address of [
      '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
      'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
      'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4',
    ]) {
      expect(isValidBitcoinAddress(address), address).toBe(true)
    }
  })

  it('rejects a single wrong character, mixed case, other networks and the wrong checksum variant', () => {
    for (const address of [
      'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5',
      '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb',
      'bc1qW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      // Testnet.
      'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      // Version 1 with a bech32 (not bech32m) checksum, from BIP 350's invalid list.
      'bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4',
      '',
      '0x52908400098527886E0F7030069857D2E4169EE7',
    ]) {
      expect(isValidBitcoinAddress(address), address).toBe(false)
    }
  })

  it('accepts the address DBison ships with', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const bitcoin = supportOptions(pkg).crypto.find(entry => entry.network === 'Bitcoin')

    expect(bitcoin).toEqual({
      name: 'Bitcoin',
      network: 'Bitcoin',
      address: 'bc1qmezxqy5m3kgmeyp7vcq9ctxv7tc793snv4fzvm',
      uri: 'bitcoin:bc1qmezxqy5m3kgmeyp7vcq9ctxv7tc793snv4fzvm',
    })
  })
})

describe('supportOptions', () => {
  it('treats the empty placeholders as nothing set up', () => {
    const pkg = { support: { github: '', kofi: '', crypto: [{ name: 'Bitcoin', network: 'Bitcoin', address: '' }] } }
    expect(supportOptions(pkg)).toEqual({ github: null, kofi: null, crypto: [] })
    expect(supportOptions({})).toEqual({ github: null, kofi: null, crypto: [] })
  })

  it('turns a Ko-fi username or page URL into the page URL', () => {
    expect(supportOptions({ support: { kofi: ' dbison ' } }).kofi).toBe('https://ko-fi.com/dbison')
    expect(supportOptions({ support: { kofi: 'https://ko-fi.com/dbison/' } }).kofi).toBe('https://ko-fi.com/dbison')
    expect(supportOptions({ support: { kofi: 'https://www.ko-fi.com/dbison' } }).kofi).toBe('https://ko-fi.com/dbison')
  })

  it('refuses anything that is not a Ko-fi page', () => {
    for (const kofi of ['http://ko-fi.com/dbison', 'https://ko-fi.com.evil.example/dbison', 'https://example.com/dbison', 'ko-fi.com/dbison', 'https://ko-fi.com/']) {
      expect(supportOptions({ support: { kofi } }).kofi).toBeNull()
    }
  })

  it('turns a GitHub username or Sponsors URL into the Sponsors page URL', () => {
    expect(supportOptions({ support: { github: ' janvorisek ' } }).github).toBe('https://github.com/sponsors/janvorisek')
    expect(supportOptions({ support: { github: 'https://github.com/sponsors/DBison-App/' } }).github).toBe('https://github.com/sponsors/DBison-App')
  })

  it('refuses anything that is not a GitHub Sponsors page', () => {
    for (const github of ['-jan', 'jan-', 'jan--v', 'http://github.com/sponsors/jan', 'https://github.com/jan', 'https://github.com.evil.example/sponsors/jan', 'a'.repeat(40)]) {
      expect(supportOptions({ support: { github } }).github).toBeNull()
    }
  })

  it('keeps complete crypto entries, trimmed, with a wallet link only for Bitcoin', () => {
    const pkg = {
      support: {
        crypto: [
          { name: ' Bitcoin ', network: 'Bitcoin', address: ' bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4 ' },
          { name: 'USDC', network: 'Ethereum (ERC-20)', address: '0xabc' },
          { name: 'USDC', network: '', address: '0xabc' },
        ],
      },
    }
    expect(supportOptions(pkg).crypto).toEqual([
      {
        name: 'Bitcoin',
        network: 'Bitcoin',
        address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
        uri: 'bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      },
      { name: 'USDC', network: 'Ethereum (ERC-20)', address: '0xabc', uri: null },
    ])
  })

  it('stops the build on a Bitcoin address that fails its checksum', () => {
    const pkg = { support: { crypto: [{ name: 'Bitcoin', network: 'Bitcoin', address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5' }] } }
    expect(() => supportOptions(pkg)).toThrow(/not a valid Bitcoin address/)
  })
})

describe('sourceUrl', () => {
  it('reads every form npm allows for a GitHub repository', () => {
    for (const repository of [
      'DBisonApp/dbison',
      'github:DBisonApp/dbison',
      'https://github.com/DBisonApp/dbison',
      'https://github.com/DBisonApp/dbison.git',
      { type: 'git', url: 'git+https://github.com/DBisonApp/dbison.git' },
      { url: 'git@github.com:DBisonApp/dbison.git' },
    ]) {
      expect(sourceUrl({ repository })).toBe('https://github.com/DBisonApp/dbison')
    }
  })

  it('is null without a GitHub repository', () => {
    expect(sourceUrl({})).toBeNull()
    expect(sourceUrl({ repository: 'https://gitlab.com/DBisonApp/dbison' })).toBeNull()
    expect(sourceUrl({ repository: 'https://github.com.evil.example/DBisonApp/dbison' })).toBeNull()
  })
})
