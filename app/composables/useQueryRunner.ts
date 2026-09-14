import type { CellValue, QueryContext, QueryResult, ResultColumn } from '#shared/db-types'

/** Rejection reason for a statement the user stopped, as opposed to one that failed. */
export function isCancellation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'cancelled' in error && error.cancelled)
}

export interface RunOptions {
  /**
   * Have the rows pushed as they arrive. `onRows` sees each batch — the
   * first with the columns — and `result` still resolves with every row
   * assembled, so a caller that only wants the end can ignore the batches.
   */
  stream?: boolean
  onRows?: (rows: CellValue[][], columns: ResultColumn[]) => void
  /** How binary values travel; see the bridge's `query` options. */
  binary?: 'digest' | 'base64'
  /**
   * The user has confirmed a write on a connection marked read-only. The
   * main process refuses such a statement without it; see `allowWrite` on
   * the bridge's `query`.
   */
  allowWrite?: boolean
}

export function useQueryRunner() {
  const { bridge } = useDatabaseBridge()

  /**
   * Runs one statement (or script) where `context` points: an open connection,
   * and the database and schema the caller is working in. The context travels
   * with every statement rather than being set once on the session, because
   * two query tabs on the same connection may sit in different databases.
   *
   * The id is minted here rather than by the main process so `stop()` works
   * from the moment the call is made — including before the query has even been
   * acknowledged, which is exactly when a runaway statement needs stopping.
   */
  function run(context: QueryContext, sql: string, maxRows?: number, options: RunOptions = {}) {
    const queryId = crypto.randomUUID()

    // Subscribed before the query is sent: the first batch can be on its way
    // back before the invoke has even returned.
    const collected: CellValue[][] = []
    let columns: ResultColumn[] = []
    /** Woken per batch, for the wait below. */
    let arrived: (() => void) | null = null
    const unsubscribe = options.stream
      ? bridge().onQueryRows((batch) => {
          if (batch.queryId !== queryId) return
          if (batch.columns) columns = batch.columns
          for (const row of batch.rows) collected.push(row)
          options.onRows?.(batch.rows, columns)
          arrived?.()
        })
      : null

    /**
     * The batches and the reply travel on different IPC paths, and nothing
     * promises their order: a one-row result's only batch can land a tick
     * after the reply that counts it. The reply says how many rows were
     * sent, so the last batch is simply waited for — briefly, since a batch
     * that never comes must not hang the tab.
     */
    async function settle(expected: number) {
      const deadline = Date.now() + 2_000
      while (collected.length < expected && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          const timer = window.setTimeout(resolve, 100)
          arrived = () => {
            window.clearTimeout(timer)
            resolve()
          }
        })
      }
      arrived = null
    }

    const result: Promise<QueryResult> = (async () => {
      if (!context.connectionId) throw new Error('Pick a connection before running a statement.')
      if (!sql.trim()) throw new Error('Nothing to run: the statement is empty.')

      const outcome = await bridge().query(context.connectionId, sql, {
        queryId,
        maxRows,
        database: context.database,
        schema: context.schema,
        transactionId: context.transactionId,
        stream: options.stream,
        binary: options.binary,
        allowWrite: options.allowWrite,
      })

      // A streamed result arrives empty; what was collected is the result.
      if (!outcome.streamed) return outcome

      if (collected.length < outcome.rowCount) await settle(outcome.rowCount)
      return { ...outcome, rows: collected }
    })().finally(() => unsubscribe?.())

    return {
      queryId,
      result,
      /** Resolves once the request is in; the statement itself stops shortly after. */
      stop: () => bridge().cancel(queryId).catch(() => ({ cancelled: false })),
    }
  }

  return { run }
}
