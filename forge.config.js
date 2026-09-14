import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

import { createHash } from 'crypto';
import { createReadStream, readFileSync } from 'fs';
import { stat, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { linuxChannelFile, linuxUpdateManifest, updateFeed } from './shared/update-feed.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The S3 bucket releases are uploaded to and served from, from package.json's
// `updates` field; null until that is filled in. docs/RELEASING.md says what
// to set; nothing here invents a bucket.
const feed = updateFeed(JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')));

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

const WINDOWS_CERT_FILE = process.env.WINDOWS_CERT_FILE;
const WINDOWS_CERT_PASSWORD = process.env.WINDOWS_CERT_PASSWORD;
const windowsSigning = WINDOWS_CERT_FILE
  ? { certificateFile: WINDOWS_CERT_FILE, certificatePassword: WINDOWS_CERT_PASSWORD }
  : {};

// asar kind of creates encryption around your files
// extraResources are the files which you want to keep outside of asar
// remember that these will be exposed to the user as well
// Rendered from the logo by scripts/make-icons.mjs and committed.
const ICON_BASE = path.join(__dirname, 'assets', 'icon');
const WINDOWS_ICON = `${ICON_BASE}.ico`;
const LINUX_ICON = `${ICON_BASE}.png`;

export const packagerConfig = {
  ...macSigning,
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
  // Ship the built Nitro server alongside the asar; main.js runs it from
  // process.resourcesPath. Requires `nuxt build` before packaging.
  extraResource: [
    path.join(__dirname, '.output'),
  ],
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
      ...windowsSigning,
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
    config: { options: { icon: LINUX_ICON, genericName: 'Database Client', categories: ['Development'] } },
  },
  {
    name: '@electron-forge/maker-rpm',
    // rpmbuild refuses a spec without a License tag; this is closed source.
    config: { options: { license: 'Proprietary', icon: LINUX_ICON, genericName: 'Database Client', categories: ['Development'] } },
  },
];
async function sha512(file) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
}

export const hooks = {
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
    // main.js re-spawns this binary as node to run the Nitro server,
    // so this fuse has to stay enabled.
    [FuseV1Options.RunAsNode]: true,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  }),
];