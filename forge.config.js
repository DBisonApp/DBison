import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { updateFeed } from './shared/update-feed.js';

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
export const packagerConfig = {
  ...macSigning,
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
    config: { ...windowsSigning },
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
    config: {},
  },
  {
    name: '@electron-forge/maker-rpm',
    config: {},
  },
];
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