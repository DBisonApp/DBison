import { describe, expect, it } from 'vitest'

import { createCsvParser, csvLine, guessDelimiter, looksLikeHeader, sqlLiteral } from '../electron/csv.js'

function parse(text, options) {
  const parser = createCsvParser(options)
  return [...parser.write(text), ...parser.end()]
}

describe('createCsvParser', () => {
  it('reads plain rows with either line ending and no trailing newline', () => {
    expect(parse('a,b\r\n1,2\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']])
  })

  it('reads quoted fields with delimiters, doubled quotes and newlines inside', () => {
    expect(parse('"x, y","say ""hi""","two\nlines"\n')).toEqual([['x, y', 'say "hi"', 'two\nlines']])
  })

  it('keeps empty fields and drops a byte-order mark', () => {
    expect(parse('﻿a,,c\n,,\n')).toEqual([['a', '', 'c'], ['', '', '']])
  })

  it('carries state across chunk boundaries, including a split CRLF and a split quote', () => {
    const parser = createCsvParser()
    const rows = [
      ...parser.write('a,"b'),
      ...parser.write('c",d\r'),
      ...parser.write('\n1,2,3\n'),
      ...parser.end(),
    ]
    expect(rows).toEqual([['a', 'bc', 'd'], ['1', '2', '3']])
  })

  it('honours another delimiter', () => {
    expect(parse('a;b\n"1;5";2\n', { delimiter: ';' })).toEqual([['a', 'b'], ['1;5', '2']])
  })

  it('skips blank lines between records', () => {
    expect(parse('a,b\n\n1,2\n\n')).toEqual([['a', 'b'], ['1', '2']])
  })
})

describe('guessDelimiter', () => {
  it('picks the delimiter that splits every line the same way', () => {
    expect(guessDelimiter('id;name;city\n1;Ada;London\n2;Grace;New York, NY\n')).toBe(';')
    expect(guessDelimiter('id\tname\n1\tAda\n')).toBe('\t')
    expect(guessDelimiter('id,name\n1,Ada\n')).toBe(',')
  })

  it('falls back to a comma for a single-column file', () => {
    expect(guessDelimiter('id\n1\n2\n')).toBe(',')
  })
})

describe('looksLikeHeader', () => {
  it('sees a header when the first row is words and the next has numbers', () => {
    expect(looksLikeHeader([['id', 'name'], ['1', 'Ada']])).toBe(true)
  })

  it('does not see one when the first row already holds numbers', () => {
    expect(looksLikeHeader([['1', 'Ada'], ['2', 'Grace']])).toBe(false)
  })
})

describe('csvLine and sqlLiteral', () => {
  it('quotes only what needs quoting and writes NULL as asked', () => {
    expect(csvLine(['plain', 'has,comma', 'has "quote"', null, 3], { nullText: 'NULL' }))
      .toBe('plain,"has,comma","has ""quote""",NULL,3\n')
  })

  it('writes SQL literals with quotes doubled and backslashes optionally escaped', () => {
    expect(sqlLiteral("it's")).toBe("'it''s'")
    expect(sqlLiteral('a\\b', { escapeBackslashes: true })).toBe("'a\\\\b'")
    expect(sqlLiteral(null)).toBe('null')
    expect(sqlLiteral(true)).toBe('true')
  })
})
