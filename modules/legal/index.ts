import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { addVitePlugin, defineNuxtModule } from '@nuxt/kit'

import { parseAuthor } from '../../shared/package-meta.js'
import { formatNotices, noticeFor, packageDirFromModuleId, productionPackageDirs } from './notices'

/**
 * Publishes the legal documents under `/legal`: the licence agreement and the
 * privacy statement from `public/legal`, and `third-party-notices.txt`, which
 * is written here while the client bundle is built. It credits the npm
 * packages the bundler actually put into the renderer, the files copied
 * beside it, the bundled fonts and the main process's production dependencies.
 * A dev server builds no bundle, so there the notices are whatever the last
 * build left behind.
 */
const NOTICES_FILE = 'third-party-notices.txt'

// Copied to /monaco by `modules/monaco-assets.ts` rather than bundled, so the
// bundler never sees them.
const COPIED_PACKAGES = ['modern-monaco']

const preamble = (author: string) => [
  [
    'DBison third-party notices',
    '',
    `DBison is proprietary software, copyright (c) 2026 ${author}. It includes`,
    'the open-source components listed below, each under its own licence, which',
    'is reproduced as its authors ship it. Nothing in the DBison licence',
    'agreement limits the rights those licences grant.',
    '',
    'Electron and Chromium, which DBison runs on, ship their licences in the',
    'files LICENSE and LICENSES.chromium.html in the DBison installation folder.',
  ].join('\n'),
]

export default defineNuxtModule({
  meta: { name: 'legal-assets' },

  setup(_options, nuxt) {
    const rootDir = nuxt.options.rootDir
    // Not `buildDir`: Nuxt empties that while building, taking the file with it.
    const target = join(rootDir, 'node_modules/.cache/legal')
    const fontsDir = join(rootDir, 'modules/legal/fonts')

    mkdirSync(target, { recursive: true })

    nuxt.hook('nitro:config', (config) => {
      config.publicAssets ??= []
      config.publicAssets.push({ dir: target, baseURL: '/legal' })
    })

    if (nuxt.options.dev) return

    addVitePlugin({
      name: 'dbison:third-party-notices',
      apply: 'build',

      generateBundle(_output, bundle) {
        const packageDirs = new Set<string>()
        for (const item of Object.values(bundle)) {
          if (item.type !== 'chunk') continue
          for (const id of item.moduleIds ?? Object.keys(item.modules)) {
            const dir = packageDirFromModuleId(id)
            if (dir) packageDirs.add(dir)
          }
        }

        // An empty list means the bundler stopped reporting module ids, not
        // that the renderer has no dependencies; better no build than a
        // shipped app without its notices.
        if (packageDirs.size === 0) {
          throw new Error('third-party notices: the client bundle reported no npm packages')
        }

        for (const name of COPIED_PACKAGES) packageDirs.add(join(rootDir, 'node_modules', name))
        for (const dir of productionPackageDirs(rootDir)) packageDirs.add(dir)

        const fonts = existsSync(fontsDir)
          ? readdirSync(fontsDir).filter(file => file.endsWith('.txt')).sort()
            .map(file => readFileSync(join(fontsDir, file), 'utf8').trim())
          : []

        const notices = [...packageDirs]
          .filter(dir => existsSync(join(dir, 'package.json')))
          .map(noticeFor)
          .filter(notice => notice.name !== 'dbison')
        const author = parseAuthor(JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')).author).name
        writeFileSync(join(target, NOTICES_FILE), formatNotices(notices, [...preamble(author), ...fonts]))
      },
    }, { server: false })
  },
})
