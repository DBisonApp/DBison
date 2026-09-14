import type { DriverError } from '#shared/db-types'

/**
 * A fault the engine located precisely enough to point at in the editor.
 * Line and column are 1-based, as Monaco counts them.
 */
export interface SqlProblem {
  message: string
  line: number
  column: number
  /** Characters to underline, always at least one so the marker is visible. */
  length: number
}

/**
 * Rebuilds the driver's own error shape from what the bridge rejected with.
 *
 * `electron/preload.cjs` copies the serialized fields onto a real Error, and
 * `message` is not an enumerable property of one — spreading it would quietly
 * drop the only field that is always there.
 */
export function toDriverError(cause: unknown): DriverError {
  if (!(cause instanceof Error)) return { message: String(cause) }

  const { code, position, length, line, column, detail, hint, raw } = cause as Error & DriverError

  return { message: cause.message, code, position, length, line, column, detail, hint, raw }
}

/** Null when the engine reported no location; there is then nothing to mark. */
export function toSqlProblem(error: DriverError | null): SqlProblem | null {
  if (!error?.line || !error.column) return null

  return {
    message: error.message,
    line: error.line,
    column: error.column,
    length: Math.max(1, error.length ?? 1),
  }
}
