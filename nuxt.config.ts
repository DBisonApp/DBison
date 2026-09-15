import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'

import pkg from './package.json'
import { parseAuthor, supportOptions } from './shared/package-meta.js'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  // The renderer is an Electron window talking to local databases: there is no
  // crawler to serve and no request-time data, so we ship a plain SPA. It also
  // keeps DOM-heavy widgets (dockview, result grids) free of hydration concerns.
  ssr: false,

  // What stands in the shell until Vue mounts. It lives outside `app/` because
  // `main.js` loads the very same file off disk to fill the longer wait before
  // the server is even listening — see the note at the top of it.
  spaLoadingTemplate: fileURLToPath(new URL('shared/splash.html', import.meta.url)),

  modules: ['@nuxt/eslint', '@nuxt/icon', '@nuxtjs/google-fonts'],

  // The About and Support dialogs read the shipped version, the author and the
  // support options from here rather than being edited alongside package.json
  // and drifting from it.
  runtimeConfig: {
    public: {
      version: pkg.version,
      author: parseAuthor(pkg.author),
      support: supportOptions(pkg),
    },
  },

  css: [
    // Before main.css so our own tokens and Tailwind utilities win.
    'dockview-vue/dist/styles/dockview.css',
    // The ER diagram canvas; its default theme is overridden the same way.
    '@vue-flow/core/dist/style.css',
    '@vue-flow/core/dist/theme-default.css',
    '@vue-flow/minimap/dist/style.css',
    '~/assets/css/main.css',
  ],

  // Components are grouped in folders for navigation, not namespacing, so the
  // directory is dropped from the auto-imported name (`chrome/AppMenuBar.vue`
  // stays `<AppMenuBar>`).
  components: [{ path: '~/components', pathPrefix: false }],

  app: {
    head: {
      title: 'DBison',
      meta: [{ name: 'color-scheme', content: 'dark light' }],
      script: [
        {
          // Where modern-monaco looks up its editor core. Without this it
          // imports 8 MB from esm.sh; `modules/monaco-assets.ts` serves the
          // copy from node_modules instead. Has to be in the document before
          // any module script runs, hence the priority.
          type: 'importmap',
          innerHTML: JSON.stringify({
            imports: { 'modern-monaco/editor-core': '/monaco/editor-core.mjs' },
          }),
          tagPriority: 'critical',
        },
      ],
    },
  },

  /**
   * Icons are compiled into the bundle rather than fetched.
   *
   * The default provider asks the Iconify API for anything it does not have,
   * which in a desktop app talking to a database on localhost means an icon
   * that silently never arrives. `AppIcon.vue` names them dynamically, so the
   * scanner cannot find them: the list here is that component's map, and the
   * two are meant to be edited together.
   */
  icon: {
    mode: 'svg',
    provider: 'none',
    // There is no server at runtime — the renderer is a built SPA in a window —
    // so the client bundle below is the only copy that matters.
    serverBundle: false,
    clientBundle: {
      icons: [
        'lucide:chevron-right',
        'lucide:chevron-down',
        'lucide:chevron-left',
        'lucide:chevron-up',
        'lucide:arrow-up-narrow-wide',
        'lucide:arrow-down-wide-narrow',
        'lucide:chevrons-up-down',
        'lucide:database',
        'lucide:layers',
        'lucide:table-2',
        'lucide:columns-3',
        'lucide:play',
        'lucide:square',
        'lucide:plus',
        'lucide:refresh-cw',
        'lucide:x',
        'lucide:search',
        'lucide:sun',
        'lucide:moon',
        'lucide:panel-left',
        'lucide:panel-right',
        'lucide:triangle-alert',
        'lucide:eye',
        'lucide:check',
        'lucide:pencil',
        'lucide:trash-2',
        'lucide:link',
        'lucide:key-round',
        'lucide:external-link',
        'lucide:case-sensitive',
        'lucide:hash',
        'lucide:toggle-left',
        'lucide:calendar',
        'lucide:clock',
        'lucide:calendar-clock',
        'lucide:braces',
        'lucide:binary',
        'lucide:list',
        'lucide:zap',
        'lucide:server',
        'lucide:keyboard',
        'lucide:layout-dashboard',
        'lucide:copy',
        'lucide:maximize-2',
        'lucide:pin',
        'lucide:eye-off',
        'lucide:lock',
        'lucide:ellipsis',
        'lucide:plug',
        'lucide:unplug',
        'lucide:waypoints',
        'lucide:history',
        'lucide:wand-sparkles',
        'lucide:save',
        'lucide:folder-open',
        'lucide:file-code-2',
        'lucide:list-tree',
        'lucide:code',
        'lucide:calculator',
        'lucide:list-ordered',
        'lucide:settings-2',
        'lucide:zoom-in',
        'lucide:zoom-out',
        'lucide:palette',
        'lucide:download',
        'lucide:image-down',
        'lucide:folder',
        'lucide:copy-plus',
        'lucide:import',
        'lucide:file-json',
        'lucide:bookmark',
        'lucide:bookmark-plus',
        'lucide:tag',
        'lucide:git-fork',
        'lucide:file-down',
        'lucide:file-up',
        'lucide:folder-search',
        'lucide:archive',
        'lucide:archive-restore',
        'lucide:terminal',
        'lucide:heart',
        'lucide:coffee',
        'lucide:wallet',
        'lucide:sparkles',
        'lucide:bug',
        'lucide:shield-check',
        'lucide:message-circle-heart',
        'lucide:coins',
        // Engine logos, named by `DriverIcon.vue`.
        'devicon:postgresql',
        'devicon:mysql',
        'devicon:mariadb',
        'devicon:sqlite',
      ],
    },
  },

  googleFonts: {
    families: {
      // UI chrome.
      Inter: [400, 500, 600],
      // The wordmark and empty-state headings only; see `--font-display`.
      'Space Grotesk': [500, 600, 700],
      // SQL editor and result cells; tabular figures keep columns aligned.
      'JetBrains Mono': [400, 500],
    },
    display: 'swap',
    download: true,
  },

  vite: {
    plugins: [tailwindcss()],
  },
})
