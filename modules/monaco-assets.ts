import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineNuxtModule } from '@nuxt/kit'

/**
 * modern-monaco keeps the editor core out of its own bundle and pulls it in at
 * runtime — from esm.sh unless the page's import map says otherwise. A desktop
 * client has to open a query tab on a plane, so we copy the runtime files out
 * of node_modules and serve them from `/monaco`; `app.head` in `nuxt.config`
 * points the import map there.
 *
 * The file names have to survive the copy: `editor-core.mjs` spawns its worker
 * from `./editor-worker-main.mjs`, which in turn imports `./editor-worker.mjs`.
 * That also rules out letting Vite hash them as assets.
 */
const RUNTIME_FILES = ['editor-core.mjs', 'editor-worker-main.mjs', 'editor-worker.mjs']

export default defineNuxtModule({
  meta: { name: 'monaco-assets' },

  setup(_options, nuxt) {
    // The package exposes ESM-only export conditions, so `require.resolve`
    // cannot see it.
    const dist = dirname(fileURLToPath(import.meta.resolve('modern-monaco')))
    // Not `buildDir`: Nuxt empties that while building, taking the copy with it.
    const target = join(nuxt.options.rootDir, 'node_modules/.cache/monaco')

    mkdirSync(target, { recursive: true })

    for (const file of RUNTIME_FILES) {
      const from = join(dist, file)
      const to = join(target, file)

      // Skip re-copying 8 MB on every dev restart; a version bump changes size.
      if (existsSync(to) && statSync(to).size === statSync(from).size) continue

      copyFileSync(from, to)
    }

    nuxt.hook('nitro:config', (config) => {
      config.publicAssets ??= []
      config.publicAssets.push({ dir: target, baseURL: '/monaco' })
    })
  },
})
