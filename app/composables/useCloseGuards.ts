/**
 * Who has unsaved work, and how to ask them before closing.
 *
 * A tab with a dirty script or staged edits registers a guard here: a
 * function that asks the user and answers whether the close may go ahead.
 * The custom tab's close button, Ctrl+W and the window's own close all
 * consult it, so there is one dialog and one place that knows the answer.
 */
export interface CloseGuard {
  /** Whether closing now would lose something. Read reactively. */
  dirty: () => boolean
  /** Asks, when dirty; resolves true when the close may proceed. */
  mayClose: () => Promise<boolean>
}

/** Module-level on purpose: dockview mounts panels outside the app tree. */
const guards = shallowReactive(new Map<string, CloseGuard>())

export function useCloseGuards() {
  const { isAvailable, bridge } = useDatabaseBridge()

  function register(panelId: string, guard: CloseGuard) {
    guards.set(panelId, guard)
    return () => { guards.delete(panelId) }
  }

  /** Resolves true when the panel has no guard, is clean, or was allowed. */
  async function mayClose(panelId: string) {
    const guard = guards.get(panelId)
    if (!guard || !guard.dirty()) return true
    return guard.mayClose()
  }

  const anyDirty = computed(() => [...guards.values()].some((guard) => guard.dirty()))

  /**
   * Keeps the main process informed, because it is the main process that
   * receives the window's close and has to decide whether to ask. Mounted
   * once, from the layout.
   */
  function reportToWindow() {
    if (!isAvailable.value) return

    watch(anyDirty, (dirty) => { bridge().setDirty(dirty).catch(() => {}) }, { immediate: true })
  }

  return { register, mayClose, anyDirty, reportToWindow }
}
