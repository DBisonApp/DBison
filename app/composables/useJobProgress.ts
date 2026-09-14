import type { ProgressUpdate } from '#shared/db-types'

/** How many of a tool's lines are kept; a restore prints one per table and then some. */
const LINE_CAP = 200

/**
 * The running figures of a long job — an export, an import, a dump — as the
 * main process reports them.
 *
 * Every job's pushes arrive on the one `onProgress` channel; this keeps the
 * ones for a single `jobId` and drops the rest, so a dialog only ever reads
 * its own numbers. `stop()` unsubscribes and has to be called when the job is
 * over, or the listener outlives the dialog that wanted it.
 */
export function useJobProgress() {
  const { bridge } = useDatabaseBridge()

  function watchJob(jobId: string) {
    const job = reactive({
      rows: 0,
      bytes: 0,
      /** What a command-line tool printed, most recent last. */
      lines: [] as string[],
      stop: () => {},
    })

    const unsubscribe = bridge().onProgress((update: ProgressUpdate) => {
      if (update.jobId !== jobId) return

      if (update.rows !== undefined) job.rows = update.rows
      if (update.bytes !== undefined) job.bytes = update.bytes
      if (update.line !== undefined) {
        job.lines.push(update.line)
        if (job.lines.length > LINE_CAP) job.lines.splice(0, job.lines.length - LINE_CAP)
      }
    })

    job.stop = unsubscribe

    return job
  }

  return { watchJob }
}
