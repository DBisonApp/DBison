import { BridgeUnavailableError, useDatabaseBridge } from '~/composables/useDatabaseBridge'

/**
 * Sends whatever the renderer failed to catch to the main process log file.
 *
 * A packaged app has no devtools open: a component that throws while rendering
 * or a promise nobody awaited simply vanishes, and the user reports "it did
 * nothing". Vue's error handler, window `error` and `unhandledrejection` all
 * end up here, still printed to the console for development and additionally
 * written through `bridge().log()` so the desktop app keeps a record.
 *
 * Nothing in here may throw: an error handler that errors takes the page down
 * with it, which is the one outcome worse than a missing log line.
 */

/** Identical messages inside this window are written once. */
const REPEAT_WINDOW_MS = 3_000

const recent = new Map<string, number>()

/**
 * A render loop throws the same error on every frame; the log is for reading,
 * not for measuring the frame rate. The map is pruned as it is consulted, so
 * it never outgrows the set of errors seen in the last few seconds.
 */
function seenRecently(key: string, now: number) {
  for (const [known, at] of recent) {
    if (now - at > REPEAT_WINDOW_MS) recent.delete(known)
  }
  if (recent.has(key)) return true
  recent.set(key, now)
  return false
}

function describe(reason: unknown): { message: string, detail?: string } {
  if (reason instanceof Error) {
    return { message: reason.message || reason.name, detail: reason.stack ?? undefined }
  }
  if (reason && typeof reason === 'object') {
    try {
      return { message: JSON.stringify(reason) }
    }
    catch {
      return { message: String(reason) }
    }
  }
  return { message: String(reason) }
}

export default defineNuxtPlugin((nuxtApp) => {
  const { isAvailable, bridge } = useDatabaseBridge()

  function report(prefix: string, reason: unknown, context?: string) {
    try {
      // The bridge missing is the browser-tab case, not an error worth a line;
      // it would also recur on every report and drown the console.
      if (reason instanceof BridgeUnavailableError) return

      const { message, detail } = describe(reason)
      const line = `${prefix}: ${message}${context ? ` (${context})` : ''}`

      if (seenRecently(line, Date.now())) return

      console.error(line, reason)

      if (!isAvailable.value) return

      bridge().log({ level: 'error', message: line, detail }).catch(() => {})
    }
    catch {
      // Even the console can be gone mid-teardown; there is nowhere left to say so.
    }
  }

  nuxtApp.vueApp.config.errorHandler = (error, _instance, info) => {
    report('Vue error', error, info)
  }

  window.addEventListener('error', (event) => {
    // A failed resource load fires `error` on the element without an Error;
    // the event's own message is what there is to write down.
    report('Uncaught error', event.error ?? event.message)
  })

  window.addEventListener('unhandledrejection', (event) => {
    report('Unhandled rejection', event.reason)
  })
})
