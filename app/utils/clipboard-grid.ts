/**
 * A pasted block of cells, as a spreadsheet writes one: rows on lines, cells
 * on tabs. The literal word `NULL` is the one way text can say "no value";
 * an empty cell is an empty string, which is what an empty spreadsheet cell
 * copies as.
 */
export function parseClipboardGrid(text: string): (string | null)[][] {
  const lines = text.split(/\r?\n/)

  // A trailing newline is a spreadsheet's line terminator, not an empty row.
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()

  return lines.map((line) => line.split('\t').map((cell) => (cell === 'NULL' ? null : cell)))
}
