import { describe, expect, it } from 'vitest'

import { findParameters, substituteParameters } from '../app/utils/sql-params'

describe('findParameters', () => {
  it('finds :name and $1 markers once each, in order', () => {
    const found = findParameters(`select * from t where a = :id and b = $1 or c = :id`)
    expect(found.map((p) => p.name)).toEqual(['id', '1'])
  })

  it('ignores casts, strings and comments', () => {
    const found = findParameters(`select x::int, ':no' -- :nope\nfrom t where y = :yes`)
    expect(found.map((p) => p.name)).toEqual(['yes'])
  })

  it('leaves dollar-quoted bodies alone', () => {
    expect(findParameters(`select $$ :not a param $$`)).toEqual([])
  })
})

describe('substituteParameters', () => {
  it('writes literals in place of the markers', () => {
    const out = substituteParameters(`where a = :id and n = :name and z = $1`, { id: '42', name: `O'Brien`, 1: 'NULL' })
    expect(out).toBe(`where a = 42 and n = 'O''Brien' and z = null`)
  })

  it('does not touch a cast', () => {
    expect(substituteParameters(`select a::int`, { int: '1' })).toBe(`select a::int`)
  })
})
