import { describe, expect, it } from 'vitest'

import { sqlLiteral, toInsertStatements, toMarkdownTable } from '../app/utils/serialize'

describe('sqlLiteral', () => {
  it('quotes strings and doubles quotes', () => {
    expect(sqlLiteral(`it's`, false)).toBe(`'it''s'`)
  })

  it('doubles backslashes only for MySQL', () => {
    expect(sqlLiteral('c\\d', true)).toBe(`'c\\\\d'`)
    expect(sqlLiteral('c\\d', false)).toBe(`'c\\d'`)
  })

  it('passes null, numbers and booleans through', () => {
    expect(sqlLiteral(null, false)).toBe('null')
    expect(sqlLiteral(3.5, false)).toBe('3.5')
    expect(sqlLiteral(true, false)).toBe('true')
  })
})

describe('toInsertStatements', () => {
  it('writes one insert per row with quoted identifiers where needed', () => {
    const out = toInsertStatements(['id', 'select'], [[1, 'a'], [2, null]], { table: '"t"', quote: '"', escapeBackslashes: false })
    expect(out.split('\n')).toEqual([
      `insert into "t" (id, "select") values (1, 'a');`,
      `insert into "t" (id, "select") values (2, null);`,
    ])
  })
})

describe('toMarkdownTable', () => {
  it('escapes pipes and flattens newlines', () => {
    const out = toMarkdownTable(['a'], [['x|y\nz']])
    expect(out).toBe(`| a |\n| --- |\n| x\\|y z |`)
  })
})
