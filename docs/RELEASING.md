# Releasing DBison

Releases are built by `.github/workflows/release.yml` (or `npm run publish`
locally), uploaded to an S3-compatible bucket such as DigitalOcean Spaces, and
picked up from there by `update-electron-app` in installed apps. Nothing is
live until `package.json` names the bucket; nothing here guesses one.

## 1. Create the bucket

On DigitalOcean: **Spaces Object Storage → Create Bucket**. Pick a region (e.g.
`fra1`) and a name (e.g. `dbison-releases`). The bucket itself can stay
private: each uploaded file is given a public-read ACL. Enabling the CDN is
optional.

Then **API → Spaces Keys → Generate New Key** with read/write access to that
bucket. Keep the access key ID and secret; they are only needed where releases
are published from, never in the app.

## 2. Name the bucket in package.json

```json
"updates": {
  "bucket": "dbison-releases",
  "endpoint": "https://fra1.digitaloceanspaces.com"
}
```

Optional keys:

| Key         | Default                              | Meaning |
| ----------- | ------------------------------------ | ------- |
| `folder`    | `dbison`                             | Key prefix inside the bucket |
| `region`    | `us-east-1`                          | Signing region for the S3 client; Spaces accepts this default |
| `publicUrl` | `https://<bucket>.<endpoint host>`   | Where apps download from; set it for the Spaces CDN (`https://dbison-releases.fra1.cdn.digitaloceanspaces.com`) or a custom domain |

`shared/update-feed.js` turns this into both halves, so they cannot drift:

- `forge.config.js` configures `@electron-forge/publisher-s3`, which uploads
  every artifact to `<folder>/<platform>/<arch>/<file>`, and tells the macOS
  zip maker to write `RELEASES.json` for that same directory.
- `main.js` points `update-electron-app` (static storage) at
  `<publicUrl>/<folder>/<platform>/<arch>` in packaged builds. Without the
  field the app logs `Auto-update disabled` and skips the check.

Because the URL is baked into each build, changing the bucket later only
reaches users who install a build that already has the new value.

## 3. Add the credentials

In the GitHub repository: **Settings → Secrets and variables → Actions**.

| Secret                 | Value                   |
| ---------------------- | ----------------------- |
| `S3_ACCESS_KEY_ID`     | The Spaces access key ID |
| `S3_SECRET_ACCESS_KEY` | The Spaces secret key    |

For local publishing, export the same two variables in the shell.

## 4. Cut a release

```bash
npm version minor          # bumps package.json, commits, tags vX.Y.0
git push --follow-tags
```

The `v*` tag starts `release.yml`, which on Windows, macOS and Linux runs
`npm ci` and `npm run publish` (Nuxt build, make, upload), then keeps
`out/make/**` as a workflow artifact. As soon as the uploads finish, the new
version is live: running apps check hourly (and at start), download it in the
background and offer to restart.

Locally, `npm run publish` does the same for the current platform. Building
for another platform is not supported.

What lands in the bucket, per platform:

- **Windows** (`win32/x64/`): `dbison-X.Y.Z Setup.exe` for new installs, plus
  `RELEASES` and the `-full.nupkg` that Squirrel updates from.
- **macOS** (`darwin/arm64/`): the zip and `RELEASES.json`, which lists every
  version published so far with the newest as current. The maker reads the
  existing manifest from the bucket while building, so publish macOS versions
  in order. `macos-latest` builds arm64 only; Intel Macs need an x64 job.
- **Linux** (`linux/x64/`): `.deb` and `.rpm` for manual download. Electron's
  updater does not support Linux.

Uploading the same version again overwrites its files. To pull a bad release,
publish a higher version; deleting files only stops new downloads.

## 5. Code signing

Signing switches on only when the corresponding secrets exist.

**macOS updates require it**: Squirrel.Mac refuses to install an update that
is not signed by the same Developer ID as the running app, so unsigned macOS
builds install but never update.

### macOS

| Secret                        | Value                                                |
| ----------------------------- | ---------------------------------------------------- |
| `APPLE_ID`                    | The Apple ID of the developer account                |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password generated at appleid.apple.com |
| `APPLE_TEAM_ID`               | The 10-character team ID from the developer portal   |

`forge.config.js` then sets `osxSign: {}` and `osxNotarize` from these. The
signing certificate itself (a "Developer ID Application" identity) has to be
present in the runner's keychain; on GitHub-hosted macOS runners that means
importing it from a further secret in a step before `npm run publish`, for
example with `apple-actions/import-codesign-certs`. That step is not added here
because it depends on how the certificate is exported.

### Windows

Unsigned Windows builds update fine but show a SmartScreen warning on first
install.

| Secret                  | Value                                                   |
| ----------------------- | ------------------------------------------------------- |
| `WINDOWS_CERT_FILE`     | Path to the `.pfx` code-signing certificate on the runner |
| `WINDOWS_CERT_PASSWORD` | Its password                                            |

The Squirrel maker receives these as `certificateFile` and
`certificatePassword`. Because the value has to be a file path, a base64 secret
is typically decoded to a file in a step before `npm run publish` and the path
exported as `WINDOWS_CERT_FILE` for the following steps.

## Where things end up

- Installers: `out/make/` locally, the `dbison-<os>` workflow artifacts, and
  the bucket under `<folder>/<platform>/<arch>/`.
- The app's log, including every update check: Help → Open Log Folder, or the
  path shown in Help → About DBison. Lines start with `[update]`.
