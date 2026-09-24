import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

import { transform } from 'esbuild';

import { createHash } from 'crypto';
import { createReadStream, readFileSync } from 'fs';
import { readdir, readFile, stat, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { parseAuthor } from './shared/package-meta.js';
import { linuxChannelFile, linuxUpdateManifest, updateFeed } from './shared/update-feed.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The S3 bucket releases are uploaded to and served from, from package.json's
// `updates` field; null until that is filled in. docs/RELEASING.md says what
// to set; nothing here invents a bucket.
const pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const feed = updateFeed(pkg);

// Who makes DBison, from package.json's `author`: the copyright in the macOS
// About panel, the company in the Windows file properties, the .deb maintainer.
const AUTHOR = parseAuthor(pkg.author);

// Signing switches on with the secrets and is otherwise absent, so a local
// `npm run make` still produces an (unsigned) build without any of them.
const APPLE_ID = process.env.APPLE_ID;
const APPLE_APP_SPECIFIC_PASSWORD = process.env.APPLE_APP_SPECIFIC_PASSWORD;
const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID;
const macSigning = APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID
  ? {
      osxSign: {},
      osxNotarize: { appleId: APPLE_ID, appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD, teamId: APPLE_TEAM_ID },
    }
  : {};

// Windows signs with whichever of these the environment has:
// - WINDOWS_SIGN_PARAMS: the `signtool sign` arguments that pick a key held by
//   a cloud signing service or HSM (Azure Artifact Signing's /dlib and /dmdf,
//   a token's /sha1, …), usually with WINDOWS_SIGNTOOL_PATH pointing at a
//   signtool new enough for it. The one @electron/windows-sign bundles is from
//   2021.
// - WINDOWS_CERT_FILE and WINDOWS_CERT_PASSWORD: an exportable .pfx.
// WINDOWS_TIMESTAMP_SERVER replaces the default (DigiCert's) with either. The
// one configuration signs twice: the app's own binaries while packaging, and
// Setup.exe, Update.exe and the update package while making.
const WINDOWS_SIGN_PARAMS = process.env.WINDOWS_SIGN_PARAMS;
const WINDOWS_CERT_FILE = process.env.WINDOWS_CERT_FILE;
const windowsSign = WINDOWS_SIGN_PARAMS || WINDOWS_CERT_FILE
  ? {
      ...(WINDOWS_SIGN_PARAMS
        // The arguments already say which key; signtool's /a would pick its own.
        ? { signWithParams: WINDOWS_SIGN_PARAMS, automaticallySelectCertificate: false }
        : { certificateFile: WINDOWS_CERT_FILE, certificatePassword: process.env.WINDOWS_CERT_PASSWORD }),
      ...(process.env.WINDOWS_SIGNTOOL_PATH ? { signToolPath: process.env.WINDOWS_SIGNTOOL_PATH } : {}),
      ...(process.env.WINDOWS_TIMESTAMP_SERVER ? { timestampServer: process.env.WINDOWS_TIMESTAMP_SERVER } : {}),
      description: 'DBison',
    }
  : null;

// Rendered from the logo by scripts/make-icons.mjs and committed.
const ICON_BASE = path.join(__dirname, 'assets', 'icon');
const WINDOWS_ICON = `${ICON_BASE}.ico`;
const LINUX_ICON = `${ICON_BASE}.png`;

// Everything the packaged app is made of. The rest of the repository (the Vue
// source, tests, smoke scripts, docs, CI, build caches) stays out of it: none
// of it runs, and the source is published in the repository instead. The
// packager hands paths over relative to the project with forward slashes, and
// prunes node_modules to the production dependencies on its own.
const PACKAGED = [
  /^\/package\.json$/,
  /^\/main\.js$/,
  /^\/electron(\/|$)/,
  /^\/shared$/,
  /^\/shared\/[^/]+\.(js|html)$/,
  /^\/assets$/,
  // Only Linux windows are handed an icon at runtime; the packager reads the
  // others from the project.
  /^\/assets\/icon\.png$/,
  // The renderer `nuxt generate` built; main.js serves it over app://.
  /^\/\.output$/,
  /^\/\.output\/public(\/|$)/,
  /^\/node_modules$/,
  /^\/node_modules\//,
];

function ignoredInPackage(file) {
  if (!file) return false;
  if (file.endsWith('.map')) return true;
  // Dot-named entries under node_modules are never runtime code: .bin, .cache,
  // npm's lock copy and half-renamed install leftovers, packages' .github.
  if (file.startsWith('/node_modules/') && file.includes('/.')) return true;
  return !PACKAGED.some((pattern) => pattern.test(file));
}

// The app's own main-process sources in a copied build folder.
async function mainProcessSources(buildPath) {
  const nested = await Promise.all(['electron', 'shared'].map(async (dir) =>
    (await readdir(path.join(buildPath, dir), { recursive: true }))
      .filter((file) => /\.c?js$/.test(file))
      .map((file) => path.join(dir, file))));
  return ['main.js', ...nested.flat()];
}

export const packagerConfig = {
  ...macSigning,
  ...(windowsSign ? { windowsSign } : {}),
  appCopyright: `Copyright © 2026 ${AUTHOR.name}`,
  win32metadata: { CompanyName: AUTHOR.name, FileDescription: 'DBison' },
  // Without an extension: the packager takes icon.ico on Windows and
  // icon.icns on macOS.
  icon: ICON_BASE,
  // The bundle and window say DBison (productName); the binary stays
  // lowercase, so Squirrel keeps updating the same dbison.exe and Linux
  // installs /usr/bin/dbison.
  executableName: 'dbison',
  asar: {
    // The SQLite driver starts a worker thread from a real path on disk;
    // spawning one from inside the archive is not reliably supported. The
    // driver rewrites app.asar -> app.asar.unpacked to find it.
    unpack: '**/electron/drivers/**',
  },
  // Requires `nuxt generate` before packaging, for .output/public.
  ignore: ignoredInPackage,
};
export const rebuildConfig = {};

// Empty until the bucket is known: `electron-forge publish` then reports that
// there is nowhere to publish instead of failing inside the publisher.
// Uploaded objects are public and live immediately: installed apps pick up the
// new RELEASES / RELEASES.json on their next check. Credentials come from the
// environment only.
export const publishers = feed
  ? [
      {
        name: '@electron-forge/publisher-s3',
        config: {
          bucket: feed.bucket,
          endpoint: feed.endpoint,
          region: feed.region,
          folder: feed.folder,
          accessKeyId: process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
          public: true,
          // Keeps a CDN in front of the bucket from serving a stale manifest
          // for long after a release.
          releaseFileCacheControlMaxAge: 60,
        },
      },
    ]
  : [];

export const makers = [
  {
    name: '@electron-forge/maker-squirrel',
    platforms: ['win32'],
    config: {
      ...(windowsSign ? { windowsSign } : {}),
      // The Squirrel package id: the install folder (%LOCALAPPDATA%\dbison)
      // and what updates match on. Changing it would install a second copy.
      name: 'dbison',
      setupIcon: WINDOWS_ICON,
      // Apps & features downloads its icon at install time; postMake uploads
      // this copy next to the Windows release.
      ...(feed ? { iconUrl: `${feed.baseUrl('win32', 'x64')}/icon.ico` } : {}),
    },
  },
  {
    name: '@electron-forge/maker-zip',
    platforms: ['darwin'],
    // Squirrel.Mac reads RELEASES.json next to the zip; the maker extends the
    // one already in the bucket with this version. Per arch, as uploaded.
    config: (arch) => (feed ? { macUpdateManifestBaseUrl: feed.baseUrl('darwin', arch) } : {}),
  },
  {
    name: '@electron-forge/maker-deb',
    config: {
      options: {
        icon: LINUX_ICON,
        genericName: 'Database Client',
        categories: ['Development'],
        ...(AUTHOR.email ? { maintainer: `${AUTHOR.name} <${AUTHOR.email}>` } : {}),
      },
    },
  },
  {
    name: '@electron-forge/maker-rpm',
    // rpmbuild refuses a spec without a License tag. SPDX, as package.json.
    config: { options: { license: 'AGPL-3.0-only', icon: LINUX_ICON, genericName: 'Database Client', categories: ['Development'] } },
  },
];
async function sha512(file) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
}

export const hooks = {
  // The main process is plain JavaScript that runs as written from source. The
  // packaged copy is minified file by file, which drops the comments and local
  // names but keeps the module layout the code relies on: relative imports,
  // the SQLite worker's own file, the preload path. The renderer arrives
  // minified from the Nuxt build already.
  packageAfterCopy: async (_forgeConfig, buildPath) => {
    const files = await mainProcessSources(buildPath);
    await Promise.all(files.map(async (relative) => {
      const file = path.join(buildPath, relative);
      const { code } = await transform(await readFile(file, 'utf8'), {
        loader: 'js',
        minify: true,
        // Error classes and logged function names stay readable.
        keepNames: true,
        legalComments: 'none',
        target: 'node22',
      });
      await writeFile(file, code);
    }));
  },

  // Linux has no Squirrel: installed apps run electron-updater, which reads
  // latest-linux.yml next to the packages. It lists the .deb and .rpm of one
  // arch together, so it is attached to the first Linux result of that arch
  // and the publisher uploads it to <folder>/linux/<arch>/ with them.
  postMake: async (_forgeConfig, makeResults) => {
    if (!feed) return makeResults;

    // The icon Squirrel's iconUrl points at, uploaded to win32/x64/icon.ico.
    const windows = makeResults.find((result) => result.platform === 'win32');
    if (windows) windows.artifacts.push(WINDOWS_ICON);

    const byArch = new Map();
    for (const result of makeResults) {
      if (result.platform !== 'linux') continue;

      const packages = result.artifacts.filter((file) => /\.(deb|rpm)$/.test(file));
      if (packages.length === 0) continue;

      if (!byArch.has(result.arch)) byArch.set(result.arch, { result, packages: [] });
      byArch.get(result.arch).packages.push(...packages);
    }

    for (const [arch, { result, packages }] of byArch) {
      const files = await Promise.all(packages.map(async (file) => ({
        url: path.basename(file),
        sha512: await sha512(file),
        size: (await stat(file)).size,
      })));

      const manifest = path.join(path.dirname(result.artifacts[0]), linuxChannelFile(arch));
      await writeFile(manifest, linuxUpdateManifest({
        version: result.packageJSON.version,
        releaseDate: new Date().toISOString(),
        files,
      }));
      result.artifacts.push(manifest);
    }

    return makeResults;
  },
};

export const plugins = [
  {
    name: '@electron-forge/plugin-auto-unpack-natives',
    config: {},
  },
  // Fuses are used to enable/disable various Electron functionality
  // at package time, before code signing the application
  new FusesPlugin({
    version: FuseVersion.V1,
    // Nothing runs this binary as node (the renderer is served from the asar
    // over app://), so it cannot be borrowed as a signed Node runtime either.
    [FuseV1Options.RunAsNode]: false,
    // file:// pages get no more than a browser gives them, and cannot read
    // inside the asar. Packaged builds load no file:// page; the renderer
    // comes over app:// (main.js).
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  }),
];