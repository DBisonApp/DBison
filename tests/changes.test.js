import { describe, expect, it } from 'vitest'

import { assertOneRow, buildStatements, literalFactory } from '../electron/drivers/changes.js'

describe('buildStatements', () => {
  const dialect = { table: '"t"', quoteIdent: (n) => `"${n}"`, placeholder: (i) => `$${i}`, literal: literalFactory() }

  it('binds every value and previews the same statement with literals', () => {
    const [built] = buildStatements([{ kind: 'update', key: [{ column: 'id', value: 1 }], set: [{ column: 'name', value: `a'b` }] }], dialect)
    // The key is rendered first, so it takes the first placeholder.
    expect(built.sql).toBe(`update "t"\n   set "name" = $2\n where "id" = $1;`)
    expect(built.params).toEqual([1, `a'b`])
    expect(built.preview).toBe(`update "t"\n   set "name" = 'a''b'\n where "id" = 1;`)
  })

  it('writes an all-defaults insert the engine way', () => {
    const [built] = buildStatements([{ kind: 'insert', values: [] }], { ...dialect, emptyInsert: '() values ()' })
    expect(built.sql).toBe(`insert into "t" () values ();`)
  })
})

describe('assertOneRow', () => {
  it('accepts exactly one and refuses anything else', () => {
    expect(() => assertOneRow(1, 0)).not.toThrow()
    expect(() => assertOneRow(0, 2)).toThrow(/Statement 3 matched 0 rows/)
  })
})
