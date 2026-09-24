# Developing DBison

DBison is an Electron app with a Nuxt renderer. This page covers running it from source, the tests, packaging and the website. For how to propose a change, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Run from source

```bash
npm install
npm run dev        # Nuxt dev server on http://localhost:3000
npm start          # Electron against the dev server
```

`npm run lint`, `npm run typecheck` and `npm test` (unit tests for the pure layer) should all pass before a change lands. Note that `typecheck` regenerates `.nuxt` under a running dev server; restart the server afterwards.

## Layout

- `electron/`: the main process, with drivers, the connection manager, stores and IPC. Plain JavaScript with no build step.
- `shared/`: the IPC contract both sides import.
- `app/`: the Nuxt renderer, with components, composables and utilities.
- `tests/`: Vitest unit tests for the pure utilities.
- `smoke/`: scripts that drive the real app end to end (below).
- `scripts/`: the smoke runner, the website build and the README screenshots.

## Smoke tests

The scripts in `smoke/` drive the real app against a seeded SQLite file through Electron and print PASS or FAIL per check. They need the dev server running on port 3113:

```bash
npm run dev -- --port 3113
npm run smoke features   # the 2026-09 feature set: import/export, DDL, plan view, record view
npm run smoke tier3
```

The runner sets up the environment for you. To run a script directly instead:

```bash
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe smoke/tier3.mjs
```

The first run after the dev server starts can fail UI checks while Vite is still compiling; run it again before looking for a bug.

`smoke/backend.mjs` covers the main-process side without a window: structure changes, CSV import, streamed export and the read-only guard. It runs on SQLite by default, and on Postgres too when `PG_URL` is set (a scratch database is created and dropped):

```bash
node smoke/backend.mjs
PG_URL=postgres://user:pass@host:5432/postgres node smoke/backend.mjs
```

`smoke/server.mjs` exercises the Postgres and MySQL drivers against real servers, without the UI:

```bash
PG_URL=postgres://user:pass@host:5432/db MYSQL_URL=mysql://user:pass@host:3306/db node smoke/server.mjs
```

## README screenshots

`scripts/readme-shots.mjs` seeds a demo shop database and captures the images in `docs/screenshots/`, in the dark theme plus a light copy of the main one. With the dev server running on port 3113:

```bash
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/readme-shots.mjs
```

The database is written to `C:\data\shop.sqlite` on Windows (or `/tmp/shop.sqlite` elsewhere), because its path appears on screen; set `DEMO_DB` to put it somewhere else.

## Build

```bash
npm run package    # unpacked app in out/
npm run make       # installers for the current platform
```

Both run `nuxt generate` first. The packaged app contains only `main.js`, `electron/`, the `shared/` runtime files, the Linux icon, the generated renderer (`.output/public`) and the production dependencies. `forge.config.js` whitelists these and minifies the main-process sources in the packaged copy. The renderer is served from inside the asar over the app's own `app://dbison` protocol, so no port is opened. Anything the running app needs at runtime must be added to `PACKAGED` in `forge.config.js`. If it is an npm package the main process imports, it must also be listed under `dependencies`; everything bundled into the renderer belongs in `devDependencies`.

The privacy statement lives in `public/legal/`. `modules/legal` serves it together with `license.txt`, which is copied from `LICENSE`, and `third-party-notices.txt`, which is generated during the build. All three are shown under Help ▸ About DBison.

## Releases

Releases are built and published by `.github/workflows/release.yml` on a `v*` tag. They are uploaded to an S3-compatible bucket (for example DigitalOcean Spaces), which packaged builds auto-update from once `package.json` names it under `updates`. See [RELEASING.md](RELEASING.md) for the fields and secrets involved.

## Website

`site/index.html` is the public one-pager at <https://dbison.app>. `npm run site` builds it into `site-dist/`, and `.github/workflows/site.yml` deploys it to Cloudflare Pages. Its download links are read from the release bucket's manifests during the build, so a release moves the page onto the new version without an edit. See [WEBSITE.md](WEBSITE.md).
