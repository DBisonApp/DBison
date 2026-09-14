/**
 * The two numbers the explorer puts beside a table name.
 *
 * Both are compact on purpose. The sidebar's right edge is a column a few
 * characters wide, read at a glance rather than read properly, and the question
 * it answers is what order of magnitude a table is — a lookup table, a fact
 * table, or empty. The exact figures go in the tooltip, where there is room to
 * be precise and time to care.
 */

/** `k`, then each thousand above it. Nothing here is ever four digits wide. */
const SCALES = ['k', 'M', 'B', 'T']

/** `0`, `842`, `4.2k`, `128k`, `1.2M`. Never wider than four characters. */
export function compactCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return ''

  let scaled = value
  let scale = -1

  // 999.5 rather than 1000, because the step below rounds: without it 999,999
  // would divide once, round to 1000 and read as `1000k` instead of `1M`.
  while (scaled >= 999.5 && scale < SCALES.length - 1) {
    scaled /= 1000
    scale += 1
  }

  // One decimal only below ten, where it is the difference between 1M and 9M;
  // above that the leading digits already say enough.
  const digits = scale >= 0 && scaled < 9.95
    ? scaled.toFixed(1).replace(/\.0$/, '')
    : String(Math.round(scaled))

  return scale < 0 ? digits : `${digits}${SCALES[scale]}`
}

/** `912 B`, `4.2 KB`, `1.8 GB` — powers of 1024, as every engine reports them. */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return ''

  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let scaled = value
  let unit = 0

  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024
    unit += 1
  }

  return `${unit === 0 || scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)} ${units[unit]}`
}

/**
 * The tooltip behind the compact figure: what the number actually is, said in
 * full, and flagged as the engine's estimate rather than a count — the
 * difference matters the moment someone plans a query around it.
 */
export function describeSize(input: {
  rowEstimate?: number
  bytes?: number
  columns: number
}): string {
  const parts: string[] = []

  if (input.rowEstimate != null) {
    parts.push(`~${input.rowEstimate.toLocaleString()} row${input.rowEstimate === 1 ? '' : 's'} (estimated)`)
  }

  if (input.bytes != null) parts.push(formatBytes(input.bytes))

  parts.push(`${input.columns} column${input.columns === 1 ? '' : 's'}`)

  return parts.join(' · ')
}
