import { createReadStream } from 'node:fs'

/**
 * Delimited text, read and written a row at a time.
 *
 * The parser is written here rather than taken from a package because the
 * whole of what an import needs is RFC 4180 plus a tolerant reading of the
 * files spreadsheets actually produce: quoted fields that span lines, doubled
 * quotes, a byte-order mark, either line ending, and a delimiter that has to
 * be guessed. It works on chunks, so a file is never held whole in memory.
 */

/** The delimiters worth guessing between, in order of how often they turn up. */
const CANDIDATES = [',', ';', '\t', '|']

/**
 * A chunk-fed parser. Feed it text with `write`, collect the rows it hands
 * back, and call `end` for the last row a file without a final newline holds.
 */
export function createCsvParser({ delimiter = ',', quote = '"' } = {}) {
  let field = ''
  let row = []
  let inQuotes = false
  /** Set right after a closing quote, where only the delimiter or a newline may follow. */
  let afterQuote = false
  /** A carriage return seen at the very end of the previous chunk. */
  let pendingCr = false
  let first = true

  function finishField() {
    row.push(field)
    field = ''
    afterQuote = false
  }

  function finishRow(rows) {
    finishField()
    // A blank line between records is skipped; a single empty field is not a row.
    if (row.length > 1 || row[0] !== '') rows.push(row)
    row = []
  }

  return {
    /** @param {string} text  @returns {string[][]} the rows completed by this chunk */
    write(text) {
      const rows = []
      let i = 0

      if (first) {
        first = false
        if (text.charCodeAt(0) === 0xFEFF) i = 1
      }

      if (pendingCr) {
        pendingCr = false
        if (text[i] === '\n') i += 1
      }

      for (; i < text.length; i += 1) {
        const char = text[i]

        if (inQuotes) {
          if (char === quote) {
            if (text[i + 1] === quote) {
              field += quote
              i += 1
            }
            else {
              inQuotes = false
              afterQuote = true
            }
          }
          else {
            field += char
          }
          continue
        }

        if (char === delimiter) {
          finishField()
        }
        else if (char === '\n') {
          finishRow(rows)
        }
        else if (char === '\r') {
          if (text[i + 1] === '\n') i += 1
          else if (i === text.length - 1) pendingCr = true
          finishRow(rows)
        }
        else if (char === quote && field === '' && !afterQuote) {
          inQuotes = true
        }
        else {
          // A quote in the middle of an unquoted field is just a character;
          // text after a closing quote is kept too rather than rejected, since
          // the alternative is refusing the whole file over one cell.
          field += char
        }
      }

      return rows
    },

    /** @returns {string[][]} the last row, when the file did not end in a newline */
    end() {
      const rows = []
      if (field !== '' || row.length) finishRow(rows)
      return rows
    },
  }
}

/**
 * Which delimiter the first lines are most consistently split by.
 *
 * The one that yields the same field count on every sampled line — and more
 * than one field — wins; a tie goes to the more common character.
 */
export function guessDelimiter(sample) {
  const lines = sample.split(/\r?\n/).filter((line) => line.trim()).slice(0, 20)
  if (!lines.length) return ','

  let best = ','
  let bestScore = -1

  for (const candidate of CANDIDATES) {
    const counts = lines.map((line) => createCsvParser({ delimiter: candidate }).write(`${line}\n`)[0]?.length ?? 1)
    const width = counts[0]
    if (width < 2) continue

    const consistent = counts.every((count) => count === width)
    const score = (consistent ? 1000 : 0) + width

    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }

  return best
}

/**
 * Whether the first row looks like a header: every cell is text that is not
 * a number, and the second row differs from it in that respect somewhere.
 */
export function looksLikeHeader(rows) {
  const [first, second] = rows
  if (!first?.length) return false

  const numeric = (cell) => cell.trim() !== '' && !Number.isNaN(Number(cell))
  if (first.some(numeric)) return false
  if (first.some((cell) => cell.trim() === '')) return false
  if (!second) return true

  return second.some((cell, index) => numeric(cell) || cell !== first[index])
}

/**
 * Reads a file's rows as an async iterable of arrays of strings, decoding it
 * in chunks. Stops early when the caller stops iterating, so a preview of
 * fifty rows never reads a gigabyte.
 */
export async function* readCsvRows(path, { delimiter, encoding = 'utf8', signal } = {}) {
  const parser = createCsvParser({ delimiter })
  const stream = createReadStream(path, { encoding, highWaterMark: 256 * 1024, signal })

  try {
    for await (const chunk of stream) {
      for (const row of parser.write(chunk)) yield row
    }
    for (const row of parser.end()) yield row
  }
  finally {
    stream.destroy()
  }
}

/** One value as CSV writes it: quoted when it has to be, NULL as asked. */
export function csvCell(value, { delimiter = ',', nullText = '' } = {}) {
  if (value === null || value === undefined) return nullText

  const text = typeof value === 'string' ? value : String(value)
  const needsQuotes = text.includes(delimiter) || text.includes('"') || text.includes('\n') || text.includes('\r')
    || (nullText && text === nullText)

  return needsQuotes ? `"${text.replace(/"/g, '""')}"` : text
}

export function csvLine(values, options) {
  return `${values.map((value) => csvCell(value, options)).join(options?.delimiter ?? ',')}\n`
}

/** A string as SQL writes it, for an export of INSERT statements. */
export function sqlLiteral(value, { escapeBackslashes = false } = {}) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'

  const text = escapeBackslashes ? String(value).replace(/\\/g, '\\\\') : String(value)
  return `'${text.replace(/'/g, "''")}'`
}

export function quoteIdentifier(name, quote = '"') {
  return `${quote}${String(name).replaceAll(quote, quote + quote)}${quote}`
}
