import { describe, expect, it } from 'vitest'

import { parseClipboardGrid } from '../app/utils/clipboard-grid'

describe('parseClipboardGrid', () => {
  it('splits lines and tabs, dropping the trailing terminator', () => {
    expect(parseClipboardGrid('a\tb\r\nc\td\r\n')).toEqual([['a', 'b'], ['c', 'd']])
  })

  it('reads the literal NULL as null and keeps empty cells empty', () => {
    expect(parseClipboardGrid('NULL\t\tx')).toEqual([[null, '', 'x']])
  })

  it('keeps a single cell as one row of one cell', () => {
    expect(parseClipboardGrid('42')).toEqual([['42']])
  })
})
