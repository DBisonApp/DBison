export type AppThemeName = 'dark' | 'light'

const STORAGE_KEY = 'dbison.theme'

/**
 * The single source of truth for light/dark. Writes `data-theme` on <html>,
 * which drives both the app tokens in `main.css` and the dockview theme picked
 * in `WorkbenchLayout`.
 */
export function useAppTheme() {
  const theme = useState<AppThemeName>('app-theme', () => 'dark')
  const { isAvailable, bridge } = useDatabaseBridge()

  /**
   * Hands the main process the palette the window chrome sits on: the native
   * buttons are recoloured from it now, and it is kept so the next cold start
   * opens its window and its load screen in this theme instead of guessing.
   * The colours are read back from the stylesheet rather than repeated here,
   * so main.css stays the only place one is written. Fire-and-forget: a window
   * that cannot be recoloured is a cosmetic miss, not a reason to block the
   * theme switch.
   */
  function syncTitleBar(next: AppThemeName) {
    if (!isAvailable.value) return

    const style = getComputedStyle(document.documentElement)
    const color = style.getPropertyValue('--app-surface').trim()
    const symbolColor = style.getPropertyValue('--app-text').trim()
    const background = style.getPropertyValue('--app-bg').trim()

    if (!color || !symbolColor || !background) return

    bridge().setTitleBar({ theme: next, color, symbolColor, background }).catch(() => {})
  }

  function apply(next: AppThemeName) {
    theme.value = next

    if (import.meta.client) {
      document.documentElement.dataset.theme = next
      localStorage.setItem(STORAGE_KEY, next)
      syncTitleBar(next)
    }
  }

  function toggle() {
    apply(theme.value === 'dark' ? 'light' : 'dark')
  }

  /** Called once from the app root; restores the persisted choice. */
  function restore() {
    if (!import.meta.client) return

    const stored = localStorage.getItem(STORAGE_KEY)
    apply(stored === 'light' || stored === 'dark' ? stored : 'dark')
  }

  return { theme: readonly(theme), setTheme: apply, toggle, restore }
}
