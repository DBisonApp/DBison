/**
 * The handful of things a person sets once and expects to stay set.
 *
 * Kept in one object under one key rather than a key per preference, so the
 * settings dialog reads and writes a single shape, and a future export of "my
 * setup" is one file. The theme is deliberately not here: it is applied before
 * paint by `useAppTheme`, which needs its own key to read synchronously.
 */

export interface AppSettings {
  /**
   * Window zoom as a factor of the default: 1 is as designed, 1.25 is a
   * quarter larger. Applied through Chromium's own zoom, which scales the
   * editor, the grid and the chrome together instead of leaving one behind.
   */
  zoom: number
  /** How many rows a query result may bring back. */
  queryLimit: number
  /** Ask before every grid save, not only on connections marked read-only. */
  confirmAllWrites: boolean
  /**
   * Script files opened or saved lately, most recent first, for the File
   * menu. Paths only: the file is read again when it is picked, so a script
   * edited elsewhere in the meantime comes back as it is now.
   */
  recentFiles: string[]
}

const STORAGE_KEY = 'dbison.settings.v1'

export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]
export const QUERY_LIMIT_OPTIONS = [200, 1_000, 5_000, 50_000, 1_000_000]

/** As many as a menu can list without becoming a file browser. */
export const MAX_RECENT_FILES = 8

const DEFAULTS: AppSettings = {
  zoom: 1,
  queryLimit: 5_000,
  confirmAllWrites: false,
  recentFiles: [],
}

/** Keeps only the strings, de-duplicated and cut to the menu's length. */
function recentFilesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  const paths = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  return [...new Set(paths)].slice(0, MAX_RECENT_FILES)
}

function read(): AppSettings {
  if (!import.meta.client) return { ...DEFAULTS }

  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<AppSettings>

    return {
      zoom: ZOOM_STEPS.includes(Number(stored.zoom)) ? Number(stored.zoom) : DEFAULTS.zoom,
      queryLimit: QUERY_LIMIT_OPTIONS.includes(Number(stored.queryLimit)) ? Number(stored.queryLimit) : DEFAULTS.queryLimit,
      confirmAllWrites: typeof stored.confirmAllWrites === 'boolean' ? stored.confirmAllWrites : DEFAULTS.confirmAllWrites,
      recentFiles: recentFilesOf(stored.recentFiles),
    }
  }
  catch {
    return { ...DEFAULTS }
  }
}

export function useSettings() {
  const settings = useState<AppSettings>('app-settings', read)
  const { isAvailable, bridge } = useDatabaseBridge()

  function update(patch: Partial<AppSettings>) {
    settings.value = { ...settings.value, ...patch }

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings.value))
    }
    catch {
      // Storage can be unavailable; the choice then lasts the session.
    }
  }

  /**
   * Pushes the zoom to the window. Chromium remembers a zoom per origin on its
   * own, but that memory is Chromium's and not the app's: it would not survive
   * a cleared profile, and nothing could show it in a dialog.
   */
  function applyZoom() {
    if (!isAvailable.value) return
    bridge().setZoom(settings.value.zoom).catch(() => {})
  }

  function zoomBy(direction: 1 | -1) {
    const position = ZOOM_STEPS.indexOf(settings.value.zoom)
    const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, position + direction))]

    if (next !== undefined && next !== settings.value.zoom) {
      update({ zoom: next })
      applyZoom()
    }
  }

  function setZoom(zoom: number) {
    update({ zoom: ZOOM_STEPS.includes(zoom) ? zoom : 1 })
    applyZoom()
  }

  /**
   * Moves a path to the top of the recent list. Opening a file that is
   * already listed is a use of it, not a second copy, so it climbs rather
   * than repeats.
   */
  function rememberFile(path: string) {
    update({ recentFiles: recentFilesOf([path, ...settings.value.recentFiles]) })
  }

  /** Drops a path, for a file that turned out no longer to exist. */
  function forgetFile(path: string) {
    update({ recentFiles: settings.value.recentFiles.filter((entry) => entry !== path) })
  }

  return { settings: readonly(settings), update, applyZoom, zoomBy, setZoom, rememberFile, forgetFile }
}
