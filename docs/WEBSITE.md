# The DBison website

One page — `site/index.html` — built by `scripts/build-site.mjs` into
`site-dist/` and served by Cloudflare Pages at <https://dbison.app>. No
framework, no dependencies, no external requests: the page is a single HTML
file with its CSS and script inline, next to the icon, the screenshot and the
legal texts.

```bash
npm run site           # build into site-dist/ (reads the release bucket)
npm run site -- --offline   # no network: uses package.json's version
```

Open `site-dist/index.html` in a browser to preview it.

## Where the download links come from

Nothing about a release is hardcoded in the page. While it builds, the script
reads the same manifests installed apps update from, under
`https://dbison-releases.fra1.digitaloceanspaces.com/dbison/`:

| Platform | Manifest | What it gives |
| -------- | -------- | ------------- |
| Windows | `win32/x64/RELEASES` | the version in `dbison-<version>-full.nupkg`, next to which `DBison-<version> Setup.exe` sits |
| macOS | `darwin/arm64/RELEASES.json` | `currentRelease` and the zip's URL outright |
| Linux | `linux/x64/latest-linux.yml` | the version and both package names, `.deb` and `.rpm` |

Every resolved URL is then checked with a `HEAD` request, which also supplies
the size shown on the card. A platform whose manifest cannot be read is left
off the page rather than guessed at; if the bucket cannot be reached at all,
the page falls back to `package.json`'s version with the file names the makers
produce, and the build prints a warning. This is why the page can never offer a
build that is not in the bucket, and why it needs no edit at release time.

The bucket allows no listing and sends no CORS headers, so this has to happen
at build time — the page cannot ask the bucket anything from the visitor's
browser.

## When it deploys

`.github/workflows/site.yml` runs on:

- a push to `main` that touches the site's sources, `package.json` or the legal
  texts;
- the **Release** workflow finishing successfully — this is the run that moves
  the page onto a new version, once the installers are actually uploaded;
- `workflow_dispatch`, to rebuild by hand.

## Cloudflare Pages setup

Done once, on a free account:

1. **Create the project.** Cloudflare dashboard → Workers & Pages → Create →
   Pages → "Upload assets" (name it `dbison`), or locally:

   ```bash
   npx wrangler pages project create dbison --production-branch main
   ```

   Do not connect it to the Git repository: the deploy comes from the workflow,
   which knows when a release has landed.

2. **Add the two secrets** in the GitHub repository, under Settings → Secrets
   and variables → Actions:

   | Secret | Value |
   | ------ | ----- |
   | `CLOUDFLARE_API_TOKEN` | An API token with the **Cloudflare Pages: Edit** permission (My Profile → API Tokens → Create Token) |
   | `CLOUDFLARE_ACCOUNT_ID` | The account ID from the Workers & Pages sidebar |

3. **Point the domain at it.** Pages project → Custom domains → Set up a custom
   domain → `dbison.app`, and again for `www.dbison.app` if you want it. With
   the domain's DNS on Cloudflare the records are added for you; otherwise
   follow the CNAME the dialog shows. TLS is issued automatically.

4. Run the workflow once by hand (Actions → Site → Run workflow) and check the
   page.

To serve it somewhere else instead, set the repository variable `SITE_URL` (or
the `SITE_URL` environment variable locally) to the new base URL — it is used
for the canonical link, the Open Graph image and the sitemap — and replace the
deploy step. The built `site-dist/` is plain static files; any host will do.

## Editing the page

`site/index.html` is the template. The build replaces these placeholders, and
fails if one is left over:

| Placeholder | Filled with |
| ----------- | ----------- |
| `__VERSION__`, `__RELEASE_DATE__` | the newest version found in the bucket, and its release date |
| `__DOWNLOAD_CARDS__` | one card per download, rendered server-side so the page works without JavaScript |
| `__DOWNLOADS__` | the same list as JSON, which the page's script uses to point the hero button at the visitor's platform |
| `__SITE_URL__` | `SITE_URL`, else `https://dbison.app/` |
| `__AUTHOR__`, `__AUTHOR_EMAIL__`, `__KOFI_URL__` | `package.json`'s `author` and `support` fields |
| `__YEAR__` | the current year, for the footer |

Anything else in `site/` ships as it stands — `screenshot.png`, `robots.txt`
and `_headers` (the cache and security headers Cloudflare Pages applies). The
icon, the favicon and `public/legal/` are copied in by the build, so the
licence and privacy statement on the site are the same files the app ships.

The palette is the app's own, copied from `app/assets/css/main.css`; the page
follows the system theme and remembers the toggle.

To refresh the screenshot, take one at 2854×1402 (the smoke captures under
`shots/` are this size) and save it as `site/screenshot.png`.
