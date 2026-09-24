# DBison

A desktop database client for PostgreSQL, MySQL, MariaDB and SQLite that stays out of the way: one explorer, a query editor with schema-aware completion, and a grid that edits in place.

Free and open source under the [AGPL-3.0](LICENSE). Download it from [dbison.app](https://dbison.app).

## What it does

- **Connections** with per-connection colour and a read-only guard, SSL verification and certificates, SSH tunnels, and connection URLs you can paste. Passwords are stored through the OS keychain, never in plain text.
- **Explorer** with a fuzzy filter over tables, views, columns, functions, sequences and triggers. Fully keyboard-driven.
- **Query editor** (Monaco) with completions drawn from the live schema, foreign-key-aware JOIN suggestions, run-statement-at-cursor, whole-script runs with one result tab per statement, EXPLAIN, bind parameters, manual transactions, history, format, and `.sql` files.
- **Grid** that stages edits and writes them in one transaction, with quick filters, selection statistics, copy as INSERT / Markdown / JSON / CSV, paste from a spreadsheet, exports, pinned columns and a full-value viewer with a JSON tree and image preview.
- **Table tabs** with a WHERE box, server-side sort and paging, an on-demand exact count, and Structure and DDL views.
- **Safety**: a DELETE or UPDATE without a WHERE asks first, writes on a read-only connection ask first, unsaved work asks before a tab or the window closes.
- **Workspace**: dockview tabs and splits that survive restarts, a command palette (Ctrl+K), zoom, settings, and light and dark themes.
- **Saved queries**: name a statement, tag it, scope it to a connection or keep it for all of them; the history popover can promote a run to a saved query or forget it.
- **Import and export**: load a CSV or other delimited file into a table with column mapping, in one transaction; export every row of a table or query result to CSV, TSV, JSON or SQL INSERTs, streamed from the server past the grid's row cap.
- **Structure editing**: add, rename, change and drop columns, create and drop indexes, rename or drop tables, and create tables from a form. Every change shows its SQL before it runs.
- **Backup and restore**: runs the engine's own tool (pg_dump/psql, mysqldump/mysql, sqlite3) with the connection's settings, tunnel included, and streams its output.
- **Visual EXPLAIN**: the plan as a tree with rows, cost and per-node time bars, for Postgres, MySQL, MariaDB and SQLite.
- **Record view**: the focused row as a vertical form beside the grid (F4), with inline edits staged like any other.
- **Connections**: folders, duplicate, import and export of profiles (the app's own JSON, `.pgpass`, or a list of URLs), and a read-only mark that the main process enforces, not only the dialog.
- **Diagram**: export as SVG or PNG; dragged positions are remembered per diagram.
- **Diagnostics**: a log file under the OS log directory (Help ▸ Open Log Folder) that catches renderer and main-process errors.

## Develop

```bash
npm install
npm run dev        # Nuxt dev server on http://localhost:3000
npm start          # Electron against the dev server
```

`npm run lint`, `npm run typecheck` and `npm test` (unit tests for the pure layer) should all pass before a change lands. Note that `typecheck` regenerates `.nuxt` under a running dev server; restart the server afterwards.

## Smoke tests

The `smoke-*.mjs` scripts drive the real app against a seeded SQLite file through Electron and print PASS or FAIL per check:

```bash
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe smoke-tier3.mjs
```

Or through the runner, which sets the environment up for you:

```bash
npm run smoke features   # the 2026-09 feature set: import/export, DDL, plan view, record view
npm run smoke tier3
```

`smoke-backend.mjs` covers the main-process side without a window: structure changes, CSV import, streamed export and the read-only guard, on SQLite by default and on Postgres too when `PG_URL` is set (a scratch database is created and dropped):

```bash
node smoke-backend.mjs
PG_URL=postgres://user:pass@host:5432/postgres node smoke-backend.mjs
```

`smoke-server.mjs` exercises the Postgres and MySQL drivers against real servers, without the UI:

```bash
PG_URL=postgres://user:pass@host:5432/db MYSQL_URL=mysql://user:pass@host:3306/db node smoke-server.mjs
```

## Build

```bash
npm run package    # unpacked app in out/
npm run make       # installers for the current platform
```

Both run `nuxt generate` first. The packaged app contains only `main.js`, `electron/`, the `shared/` runtime files, the Linux icon, the generated renderer (`.output/public`) and the production dependencies; `forge.config.js` whitelists them and minifies the main-process sources in the packaged copy. The renderer is served from inside the asar over the app's own `app://dbison` protocol, so no port is opened. Anything the running app needs at runtime must be added to `PACKAGED` in `forge.config.js` and, if it is an npm package the main process imports, listed under `dependencies` (everything bundled into the renderer belongs in `devDependencies`).

The privacy statement lives in `public/legal/`. `modules/legal` serves it together with `license.txt`, which is copied from `LICENSE`, and `third-party-notices.txt`, which is generated during the build. All three are shown under Help ▸ About DBison.

Releases are built and published by `.github/workflows/release.yml` on a `v*` tag; they are uploaded to an S3-compatible bucket (e.g. DigitalOcean Spaces) that packaged builds auto-update from once `package.json` names it under `updates`. See `docs/RELEASING.md` for the fields and secrets involved.

## Website

`site/index.html` is the public one-pager at <https://dbison.app>, built by
`npm run site` into `site-dist/` and deployed to Cloudflare Pages by
`.github/workflows/site.yml`. Its download links are read from the release
bucket's manifests while it builds, so a release moves the page onto the new
version without an edit. See `docs/WEBSITE.md`.

## Layout

- `electron/` — main process: drivers, connection manager, stores, IPC. Plain JavaScript, no build step.
- `shared/` — the IPC contract both sides import.
- `app/` — the Nuxt renderer: components, composables, utilities.
- `tests/` — Vitest unit tests for the pure utilities.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Contributors sign a [CLA](CLA.md) once, from the pull request. Report security problems privately, as [SECURITY.md](SECURITY.md) describes.

## Support DBison

DBison is built by one person and has no ads, no telemetry and no account. If it saves you time, you can support it through [GitHub Sponsors](https://github.com/sponsors/janvorisek) or [Ko-fi](https://ko-fi.com/janvorisek), or with Bitcoin from Help ▸ Support DBison in the app. A star on GitHub helps too.

## Licence

Copyright © 2026 Jan Vorisek.

DBison is free software: you can redistribute it and/or modify it under the terms of the [GNU Affero General Public License, version 3](LICENSE), as published by the Free Software Foundation. It is distributed in the hope that it will be useful, but without any warranty; without even the implied warranty of merchantability or fitness for a particular purpose.

For licensing under other terms, such as a commercial licence, contact jan@vorisek.me.
