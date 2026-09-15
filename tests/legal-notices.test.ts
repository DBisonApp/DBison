import { describe, expect, it } from 'vitest'

import { formatNotices, packageDirFromModuleId } from '../modules/legal/notices'

describe('packageDirFromModuleId', () => {
  it('finds the package a bundled module belongs to', () => {
    expect(packageDirFromModuleId('C:/repo/node_modules/vue/dist/vue.runtime.esm-bundler.js'))
      .toBe('C:/repo/node_modules/vue')
  })

  it('keeps the scope of a scoped package', () => {
    expect(packageDirFromModuleId('/repo/node_modules/@vue-flow/core/dist/vue-flow-core.mjs'))
      .toBe('/repo/node_modules/@vue-flow/core')
  })

  it('credits the innermost copy of a nested package', () => {
    expect(packageDirFromModuleId('/repo/node_modules/a/node_modules/b/index.js'))
      .toBe('/repo/node_modules/a/node_modules/b')
  })

  it('normalises Windows separators and drops virtual prefixes and queries', () => {
    expect(packageDirFromModuleId('\0C:\\repo\\node_modules\\dockview-core\\dist\\styles.css?inline'))
      .toBe('C:/repo/node_modules/dockview-core')
  })

  it('ignores app code, virtual modules and bare node_modules paths', () => {
    expect(packageDirFromModuleId('C:/repo/app/app.vue')).toBeNull()
    expect(packageDirFromModuleId('\0vite/preload-helper.js')).toBeNull()
    expect(packageDirFromModuleId('/repo/node_modules/vue')).toBeNull()
    expect(packageDirFromModuleId('/repo/node_modules/@scope/')).toBeNull()
    expect(packageDirFromModuleId('/repo/node_modules/.cache/nuxt-google-fonts/css/nuxt-google-fonts.css')).toBeNull()
  })
})

describe('formatNotices', () => {
  const notice = (name: string, version: string, texts: string[] = []) =>
    ({ name, version, license: 'MIT', homepage: null, texts })

  it('sorts by name, drops duplicates and keeps the preamble first', () => {
    const text = formatNotices(
      [notice('zod', '1.0.0', ['Z']), notice('pg', '8.0.0', ['P']), notice('zod', '1.0.0', ['Z'])],
      ['Preamble'],
    )

    expect(text.indexOf('Preamble')).toBe(0)
    expect(text.indexOf('pg 8.0.0')).toBeLessThan(text.indexOf('zod 1.0.0'))
    expect(text.match(/zod 1\.0\.0/g)).toHaveLength(1)
  })

  it('says so when a package ships no licence file', () => {
    expect(formatNotices([notice('tiny', '0.1.0')])).toContain('ships no licence file; it is distributed under MIT')
  })
})
