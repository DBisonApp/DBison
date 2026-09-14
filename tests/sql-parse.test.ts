import { describe, expect, it } from 'vitest'

import { statementRange, tokenize } from '../app/utils/sql-parse'

describe('tokenize', () => {
  it('keeps a semicolon inside a string as part of the string', () => {
    const tokens = tokenize(`select 'a;b' from t; select 2`)
    const semicolons = tokens.filter((t) => t.kind === 'punct' && t.text === ';')
    expect(semicolons).toHaveLength(1)
    expect(tokens.find((t) => t.kind === 'string')?.text).toBe(`'a;b'`)
  })

  it('reads a dollar-quoted body as one string', () => {
    const tokens = tokenize(`create function f() returns int as $$ begin return 1; end $$ language plpgsql;`)
    expect(tokens.filter((t) => t.kind === 'string')).toHaveLength(1)
    expect(tokens.filter((t) => t.text === ';')).toHaveLength(1)
  })

  it('treats comments as comments', () => {
    const tokens = tokenize(`-- select nothing\nselect /* inner ; */ 1`)
    expect(tokens.filter((t) => t.kind === 'comment')).toHaveLength(2)
    expect(tokens.filter((t) => t.text === ';')).toHaveLength(0)
  })
})

describe('statementRange', () => {
  it('finds the statement the offset sits in', () => {
    const text = `select 1;\nselect 2;\nselect 3`
    const tokens = tokenize(text)
    const [start, end] = statementRange(tokens, text.indexOf('2'))
    expect(tokens.slice(start, end).map((t) => t.text)).toEqual(['select', '2'])
  })
})
