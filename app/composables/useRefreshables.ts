/**
 * What F5 means in each tab.
 *
 * Every client answers F5 with "read it again", but what "it" is depends on
 * the tab: the rows of a table, the last statement a query tab ran, the
 * schema the explorer draws. Each panel registers its own answer under its
 * panel id, and the one shortcut asks whichever tab is active.
 */
export type Refresh = () => void | Promise<void>

/** Module-level on purpose: dockview mounts panels outside the app tree. */
const refreshables = shallowReactive(new Map<string, Refresh>())

export function useRefreshables() {
  const { activePanel } = useWorkbench()

  function register(panelId: string, refresh: Refresh) {
    refreshables.set(panelId, refresh)
    return () => { refreshables.delete(panelId) }
  }

  /** The active tab's refresh, or null when it has nothing to re-read. */
  const active = computed(() => (activePanel.value ? refreshables.get(activePanel.value.id) ?? null : null))

  return { register, active }
}
