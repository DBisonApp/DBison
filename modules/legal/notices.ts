import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Collects the licence texts of the third-party packages the shipped app
 * contains, for the notices file the About dialog shows. The packages come
 * from two places: the module ids the bundler put into the renderer, and the
 * main process's production dependency tree, which ships in the asar as is.
 */

export interface PackageNotice {
  name: string
  version: string
  license: string
  homepage: string | null
  texts: string[]
}

interface Manifest {
  name?: string
  version?: string
  license?: string | { type?: string }
  licenses?: Array<string | { type?: string }>
  homepage?: string
  repository?: string | { url?: string }
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

const NODE_MODULES = '/node_modules/'
const LICENCE_FILE = /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i

/**
 * The package directory a bundled module id lives in, or null for the app's
 * own code and bundler virtual modules. The innermost node_modules wins, so a
 * nested copy is credited rather than the package that depends on it.
 */
export function packageDirFromModuleId(id: string): string | null {
  const clean = id.replace(/^\0/, '').split('?')[0]!.replace(/\\/g, '/')
  const at = clean.lastIndexOf(NODE_MODULES)
  if (at === -1) return null

  const segments = clean.slice(at + NODE_MODULES.length).split('/')
  const length = segments[0]?.startsWith('@') ? 2 : 1
  if (segments.length <= length || segments.slice(0, length).some(part => !part)) return null
  // node_modules/.cache, .vite and the like hold build output, not packages.
  if (segments[0]!.startsWith('.')) return null

  return clean.slice(0, at + NODE_MODULES.length) + segments.slice(0, length).join('/')
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Manifest
}

// Node's own lookup: the requiring package's node_modules, then each parent
// directory's, stopping at the project root.
function resolvePackageDir(rootDir: string, fromDir: string, name: string): string | null {
  const root = path.resolve(rootDir)
  let dir = path.resolve(fromDir)

  for (;;) {
    const candidate = path.join(dir, 'node_modules', name)
    if (existsSync(path.join(candidate, 'package.json'))) return candidate
    if (dir === root) return null

    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Every package reachable from the project's `dependencies`, as directories. */
export function productionPackageDirs(rootDir: string): string[] {
  const seen = new Set<string>()

  const visit = (fromDir: string, name: string) => {
    const dir = resolvePackageDir(rootDir, fromDir, name)
    // An optional dependency for another platform is simply not installed.
    if (!dir || seen.has(dir)) return
    seen.add(dir)

    const manifest = readManifest(dir)
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      visit(dir, dependency)
    }
  }

  for (const dependency of Object.keys(readManifest(rootDir).dependencies ?? {})) visit(rootDir, dependency)

  return [...seen]
}

function licenseOf(manifest: Manifest): string {
  if (typeof manifest.license === 'string') return manifest.license
  if (manifest.license?.type) return manifest.license.type
  if (manifest.licenses?.length) {
    return manifest.licenses.map(entry => (typeof entry === 'string' ? entry : entry.type ?? 'UNKNOWN')).join(' OR ')
  }
  return 'UNKNOWN'
}

function homepageOf(manifest: Manifest): string | null {
  const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  const url = manifest.homepage ?? repository
  return url ? url.replace(/^git\+/, '').replace(/\.git$/, '') : null
}

/** A package's name, version, declared licence and the licence files it ships. */
export function noticeFor(dir: string): PackageNotice {
  const manifest = readManifest(dir)
  const files = readdirSync(dir).filter(file => LICENCE_FILE.test(file)).sort()

  return {
    name: manifest.name ?? path.basename(dir),
    version: manifest.version ?? '',
    license: licenseOf(manifest),
    homepage: homepageOf(manifest),
    texts: files.map(file => readFileSync(path.join(dir, file), 'utf8').trim()),
  }
}

/**
 * One plain-text document: the preamble paragraphs, then one block per
 * package, sorted by name and deduplicated on name and version.
 */
export function formatNotices(notices: PackageNotice[], preamble: string[] = []): string {
  const unique = new Map<string, PackageNotice>()
  for (const notice of notices) unique.set(`${notice.name}@${notice.version}`, notice)

  const blocks = [...unique.values()]
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
    .map(notice => [
      `${notice.name} ${notice.version}`,
      `License: ${notice.license}`,
      ...(notice.homepage ? [notice.homepage] : []),
      '',
      notice.texts.length
        ? notice.texts.join('\n\n')
        : `The package ships no licence file; it is distributed under ${notice.license}.`,
    ].join('\n'))

  return `${[...preamble, ...blocks].join(`\n\n${'-'.repeat(72)}\n\n`)}\n`
}
