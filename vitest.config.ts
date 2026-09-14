import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

/**
 * Unit tests for the pure layer: the tokenizer, statement slicing, the
 * serializers, the change builder. Nothing here touches Nuxt or Electron,
 * so the utilities under test import what they need explicitly rather than
 * leaning on auto-imports, and the runner needs only the `#shared` alias.
 */
export default defineConfig({
  resolve: {
    alias: {
      '#shared': fileURLToPath(new URL('./shared', import.meta.url)),
      '~': fileURLToPath(new URL('./app', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.{ts,js}'],
  },
})
