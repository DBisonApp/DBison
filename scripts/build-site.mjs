// Builds the public one-page site into site-dist/.
//
// The download links are not hardcoded: the release bucket's own manifests are
// read at build time (the same files installed apps update from), so the page
// can only ever offer a build that is actually there, with its real file name
// and size. A platform whose manifest is missing is left out rather than
// guessed at; if the bucket cannot be reached at all, the page falls back to
// package.json's version with the conventional file names.
//
//   node scripts/build-site.mjs                 # fetches the manifests
//   node scripts/build-site.mjs --offline       # no network, package.json version
//   node scripts/build-site.mjs --out some/dir
//
// SITE_URL overrides the canonical URL (trailing slash added if missing).

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAuthor, sourceUrl, supportOptions } from '../shared/package-meta.js';
import { linuxChannelFile, updateFeed } from '../shared/update-feed.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SITE_URL = 'https://dbison.app/';

const args = process.argv.slice(2);
const offline = args.includes('--offline');
const outDir = join(ROOT, valueOf('--out') ?? 'site-dist');

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const feed = updateFeed(pkg);
if (!feed) throw new Error('package.json has no complete `updates` field, so there is nothing to link to');

/* Downloads ---------------------------------------------------------------- */

// One entry per file a visitor can install. `resolve` reads the platform's
// manifest from the bucket and returns the file to offer; `fallback` is the
// name the makers produce, used only when nothing could be read.
const TARGETS = [
  {
    id: 'windows',
    os: 'Windows',
    kind: 'Installer',
    platform: 'win32',
    arch: 'x64',
    fallback: (version) => `DBison-${version} Setup.exe`,
    // Squirrel's RELEASES lists `<sha> dbison-<version>-full.nupkg <size>`;
    // the installer sits next to it under the product name.
    async resolve(base) {
      const releases = await fetchText(`${base}/RELEASES`);
      const versions = [...releases.matchAll(/dbison-([0-9][^\s]*?)-full\.nupkg/g)].map((m) => m[1]);
      const version = versions.sort(compareVersions).at(-1);
      return version && { version, file: `DBison-${version} Setup.exe` };
    },
  },
  {
    id: 'macos',
    os: 'macOS',
    kind: 'Apple silicon',
    platform: 'darwin',
    arch: 'arm64',
    fallback: (version) => `DBison-darwin-arm64-${version}.zip`,
    // Squirrel.Mac's manifest names the current release and its zip outright.
    async resolve(base) {
      const manifest = JSON.parse(await fetchText(`${base}/RELEASES.json`));
      const version = manifest.currentRelease;
      const release = manifest.releases?.find((r) => r.version === version);
      const url = release?.updateTo?.url;
      return version && url ? { version, file: url.split('/').pop(), url } : null;
    },
  },
  {
    id: 'linux-deb',
    os: 'Linux',
    kind: 'Debian, Ubuntu (.deb)',
    platform: 'linux',
    arch: 'x64',
    fallback: (version) => `dbison_${version}_amd64.deb`,
    resolve: (base, arch) => resolveLinux(base, arch, '.deb'),
  },
  {
    id: 'linux-rpm',
    os: 'Linux',
    kind: 'Fedora, RHEL, openSUSE (.rpm)',
    platform: 'linux',
    arch: 'x64',
    fallback: (version) => `dbison-${version}-1.x86_64.rpm`,
    resolve: (base, arch) => resolveLinux(base, arch, '.rpm'),
  },
];

// electron-updater's Linux manifest carries the version and both package names.
async function resolveLinux(base, arch, extension) {
  const yaml = await fetchText(`${base}/${linuxChannelFile(arch)}`);
  const version = yaml.match(/^version:\s*'?([^'\n\r]+)'?/m)?.[1]?.trim();
  const file = [...yaml.matchAll(/^\s*-\s*url:\s*'?([^'\n\r]+)'?/gm)].map((m) => m[1].trim()).find((name) => name.endsWith(extension));
  const date = yaml.match(/^releaseDate:\s*'?([^'\n\r]+)'?/m)?.[1]?.trim();
  return version && file ? { version, file, date } : null;
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  // Squirrel writes RELEASES with a BOM.
  return (await response.text()).replace(/^\u{FEFF}/u, '');
}

// A download nobody can fetch is worse than one that is missing, so every URL
// is checked before it reaches the page; the size comes from the same request.
async function head(url) {
  const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return Number(response.headers.get('content-length')) || null;
}

function compareVersions(a, b) {
  const parts = (v) => v.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const [l, r] = [x[i] ?? 0, y[i] ?? 0];
    if (l === r) continue;
    if (typeof l === typeof r) return l < r ? -1 : 1;
    // A prerelease tag sorts below the plain release it belongs to.
    return typeof l === 'string' ? -1 : 1;
  }
  return 0;
}

function href(base, file) {
  return `${base}/${encodeURIComponent(file)}`;
}

async function collectDownloads() {
  if (offline) return { downloads: fallbackDownloads(), date: null, resolved: false };

  const results = await Promise.all(
    TARGETS.map(async (target) => {
      const base = feed.baseUrl(target.platform, target.arch);
      try {
        const found = await target.resolve(base, target.arch);
        if (!found) throw new Error('the manifest named no build');
        const url = found.url ?? href(base, found.file);
        return { target, version: found.version, file: found.file, url, date: found.date, size: await head(url) };
      } catch (error) {
        console.warn(`! ${target.id}: ${error.message}`);
        return null;
      }
    }),
  );

  const found = results.filter(Boolean);
  if (!found.length) {
    console.warn('! nothing could be read from the release bucket; falling back to package.json');
    return { downloads: fallbackDownloads(), date: null, resolved: false };
  }

  return {
    downloads: found.map(({ target, version, file, url, size }) => ({
      id: target.id,
      os: target.os,
      kind: target.kind,
      arch: target.arch,
      version,
      file,
      url,
      size: size ? formatSize(size) : null,
    })),
    date: found.map((f) => f.date).find(Boolean) ?? null,
    resolved: true,
  };
}

function fallbackDownloads() {
  return TARGETS.map((target) => {
    const file = target.fallback(pkg.version);
    return {
      id: target.id,
      os: target.os,
      kind: target.kind,
      arch: target.arch,
      version: pkg.version,
      file,
      url: href(feed.baseUrl(target.platform, target.arch), file),
      size: null,
    };
  });
}

function formatSize(bytes) {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

/* Rendering ---------------------------------------------------------------- */

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function card(download) {
  const detail = [download.kind, download.arch, download.size].filter(Boolean).join(' · ');
  return [
    `<div class="dl" data-id="${escapeHtml(download.id)}">`,
    `  <span class="os">${escapeHtml(download.os)}</span>`,
    `  <span class="file">${escapeHtml(detail)}</span>`,
    `  <span class="file">${escapeHtml(download.file)}</span>`,
    `  <a class="btn btn-ghost get" href="${escapeHtml(download.url)}" download>Download</a>`,
    '</div>',
  ].join('\n');
}

function formatDate(iso) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

const { downloads, date, resolved } = await collectDownloads();
const version = downloads.map((d) => d.version).sort(compareVersions).at(-1) ?? pkg.version;
const author = parseAuthor(pkg.author);
const support = supportOptions(pkg);
const source = sourceUrl(pkg);
if (!source) throw new Error('package.json has no GitHub repository for the source links');
const siteUrl = (process.env.SITE_URL || DEFAULT_SITE_URL).replace(/\/*$/, '/');

const replacements = {
  __SITE_URL__: siteUrl,
  __VERSION__: version,
  __RELEASE_DATE__: formatDate(date),
  __YEAR__: String(new Date().getUTCFullYear()),
  __AUTHOR__: author.name || 'Jan Vorisek',
  __AUTHOR_EMAIL__: author.email || '',
  __KOFI_URL__: support.kofi ?? '',
  __SPONSORS_URL__: support.github ?? '',
  __SOURCE_URL__: source,
  __DOWNLOAD_CARDS__: downloads.map(card).join('\n'),
  __DOWNLOADS__: JSON.stringify(downloads),
};

let html = await readFile(join(ROOT, 'site', 'index.html'), 'utf8');
for (const [token, value] of Object.entries(replacements)) html = html.replaceAll(token, value);

const leftover = html.match(/__[A-Z_]+__/);
if (leftover) throw new Error(`site/index.html still has the placeholder ${leftover[0]}`);

/* Output ------------------------------------------------------------------- */

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// Everything in site/ ships as it stands; index.html is the templated copy.
await cp(join(ROOT, 'site'), outDir, { recursive: true });
await writeFile(join(outDir, 'index.html'), html);

// One page, one URL; robots.txt points here.
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${siteUrl}</loc><lastmod>${new Date().toISOString().slice(0, 10)}</lastmod></url>
</urlset>
`;
await writeFile(join(outDir, 'sitemap.xml'), sitemap);

await cp(join(ROOT, 'assets', 'icon.png'), join(outDir, 'icon.png'));
await cp(join(ROOT, 'public', 'favicon.ico'), join(outDir, 'favicon.ico'));
await cp(join(ROOT, 'public', 'legal'), join(outDir, 'legal'), { recursive: true });
// The app serves the same file under the same name (`modules/legal`).
await cp(join(ROOT, 'LICENSE'), join(outDir, 'legal', 'license.txt'));

console.log(`${resolved ? 'Read' : 'Guessed'} ${downloads.length} download${downloads.length === 1 ? '' : 's'} for DBison ${version}:`);
for (const d of downloads) console.log(`  ${d.os.padEnd(8)} ${d.file}${d.size ? ` (${d.size})` : ''}`);
console.log(`\nSite built into ${outDir} (${createHash('sha256').update(html).digest('hex').slice(0, 8)}), canonical ${siteUrl}`);
