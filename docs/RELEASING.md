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

- **Windows** (`win32/x64/`): `DBison-X.Y.Z Setup.exe` for new installs, plus
  `RELEASES` and the `-full.nupkg` that Squirrel updates from.
- **macOS** (`darwin/arm64/`): the zip and `RELEASES.json`, which lists every
  version published so far with the newest as current. The maker reads the
  existing manifest from the bucket while building, so publish macOS versions
  in order. `macos-latest` builds arm64 only; Intel Macs need an x64 job.
- **Linux** (`linux/x64/`): `.deb`, `.rpm` and `latest-linux.yml`, which the
  `postMake` hook in `forge.config.js` writes with each package's sha512 and
  size.

### How Linux updates work

Electron's built-in updater has no Linux side, so `electron/linux-updater.js`
uses `electron-updater` instead (Windows and macOS stay on
`update-electron-app`):

1. At start it asks `dpkg -S` / `rpm -qf` whether a package manager owns the
   running binary. A copy run from an unpacked folder does not update.
2. It writes `app-update.yml` (feed URL and cache folder) into the user data
   folder, because Forge does not package the one electron-builder would.
3. Hourly it reads `latest-linux.yml`, downloads the matching `.deb` or `.rpm`
   in the background and verifies its checksum.
4. It asks to restart. Installing runs `dpkg -i` or `dnf`/`zypper` through
   `pkexec`, so the system asks for the user's password, then DBison relaunches.
   Nothing installs on quit without that choice.
5. Where no graphical password prompt exists (WSL, bare window managers) the
   install fails and DBison shows the `sudo apt install …` / `sudo rpm -U …`
   command for the downloaded file instead.

Packages are not GPG-signed, so the updater's trust rests on HTTPS to the
bucket and the checksum in the manifest.

Uploading the same version again overwrites its files. To pull a bad release,
publish a higher version; deleting files only stops new downloads.

## 5. Code signing

Releases are unsigned for now. Signing them later needs no code change: each
platform switches it on as soon as its secrets exist.

### What unsigned means for users

- **Windows**: SmartScreen shows "Windows protected your PC" on first run;
  More info → Run anyway. Auto-update works unsigned, so these installs move
  to signed builds by themselves once there are some.
- **macOS**: Gatekeeper will not open the app until the user allows it once,
  under System Settings → Privacy & Security → Open Anyway, or with
  `xattr -dr com.apple.quarantine /Applications/DBison.app`. Squirrel.Mac only
  installs updates into a signed app, so unsigned installs never update:
  every macOS user downloads the first signed build by hand, once.
- **Linux**: no difference. The packages are not GPG-signed either way.

### Switching signing on

1. Add the platform's secrets from the tables below.
2. Tag a release and check that job's log for the signing (and, on macOS,
   notarization) steps.
3. Set the repository variable `REQUIRE_SIGNING` to `true` under Settings →
   Secrets and variables → Actions → Variables. From then on a release job
   whose platform lacks its secrets fails before it builds, rather than
   quietly publishing an unsigned build over signed ones.

### macOS

| Secret                        | Value                                                |
| ----------------------------- | ---------------------------------------------------- |
| `APPLE_ID`                    | The Apple ID of the developer account                |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password generated at appleid.apple.com |
| `APPLE_TEAM_ID`               | The 10-character team ID from the developer portal   |

`forge.config.js` then sets `osxSign: {}` and `osxNotarize` from these. The
signing certificate itself, a "Developer ID Application" identity, has to be in
the runner's keychain as well:

| Secret                       | Value                                                  |
| ---------------------------- | ------------------------------------------------------ |
| `MACOS_CERTIFICATE_P12`      | The identity exported from Keychain Access as `.p12`, base64-encoded (`base64 -i cert.p12 \| pbcopy`) |
| `MACOS_CERTIFICATE_PASSWORD` | The password chosen when exporting it                  |

`release.yml` imports it with `apple-actions/import-codesign-certs` before
`npm run publish`. All five secrets are needed: the certificate alone signs
nothing, because `forge.config.js` switches signing on from the `APPLE_*` ones.

Without all five the macOS job publishes an unsigned build, unless
`REQUIRE_SIGNING` is set.

### Windows

Unsigned Windows builds update fine but show a SmartScreen warning on first
install.

`forge.config.js` builds one `windowsSign` configuration from the environment
and signs with it twice: `dbison.exe` and the app's other binaries while
packaging, then `Setup.exe`, `Update.exe` and the update package while making.
There are two ways to feed it, depending on the certificate.

**A cloud signing service or HSM.** Anything bought since June 2023, when
certificate authorities moved code-signing keys onto hardware tokens and cloud
HSMs, works this way: Azure Artifact Signing, SSL.com eSigner, Certum
SimplySign.

| Name                       | Kind     | Value |
| -------------------------- | -------- | ----- |
| `WINDOWS_SIGN_PARAMS`      | secret   | The `signtool sign` arguments that select the provider's key, e.g. `/dlib <dir>\Azure.CodeSigning.Dlib.dll /dmdf <dir>\metadata.json` for Azure Artifact Signing |
| `WINDOWS_SIGNTOOL_PATH`    | variable | A `signtool.exe` new enough for the provider's library. The copy bundled with `@electron/windows-sign` is 10.0.22000 (2021); GitHub's Windows runners have newer ones under `C:\Program Files (x86)\Windows Kits\10\bin\` |
| `WINDOWS_TIMESTAMP_SERVER` | variable | The provider's timestamp URL, if it requires its own (Azure Artifact Signing: `http://timestamp.acs.microsoft.com`) |

The provider's client library also has to be on the runner, installed by a
step before `npm run publish`; that step depends on the provider and gets added
when one is chosen. For Azure Artifact Signing, `AZURE_CLIENT_ID`,
`AZURE_CLIENT_SECRET` and `AZURE_TENANT_ID` are secrets the publish step
already passes through.

**An exportable `.pfx`**, from an older certificate:

| Secret                    | Value                                          |
| ------------------------- | ---------------------------------------------- |
| `WINDOWS_CERTIFICATE_PFX` | The `.pfx` code-signing certificate, base64-encoded |
| `WINDOWS_CERT_PASSWORD`   | Its password                                   |

`release.yml` decodes the certificate into the runner's temp folder and exports
its path as `WINDOWS_CERT_FILE`. If both routes are configured, the signtool
arguments win.

Signing does not silence SmartScreen straight away: every new certificate,
EV included, builds reputation through downloads first.

### Local builds

`npm run make` without any of these produces unsigned installers, which is
fine for trying a build.

## Where things end up

- Installers: `out/make/` locally, the `dbison-<os>` workflow artifacts, and
  the bucket under `<folder>/<platform>/<arch>/`.
- The app's log, including every update check: Help → Open Log Folder, or the
  path shown in Help → About DBison. Lines start with `[update]`.
