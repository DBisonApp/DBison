/**
 * What a query tab can be asked to do from outside itself.
 *
 * The File menu says "Save" and means the focused tab, but the menu bar knows
 * nothing about tabs; each query panel registers itself here under its panel
 * id and the menu looks up whichever one dockview says is active.
 */
export interface QueryPanelHandle {
  save: () => Promise<void>
  saveAs: () => Promise<void>
  format: () => Promise<void>
  /** Keeps the selection, or the whole buffer, as a named saved query. */
  saveQuery: () => Promise<void>
  /** The script file behind the tab, when it came from or went to disk. */
  filePath: () => string | null
}

/** Module-level on purpose: dockview mounts panels, not the app's own tree. */
const handles = shallowReactive(new Map<string, QueryPanelHandle>())

export function useQueryPanels() {
  const { activePanel, openQuery } = useWorkbench()
  const { bridge, isAvailable } = useDatabaseBridge()
  const { activeId } = useConnections()
  const { rememberFile, forgetFile } = useSettings()

  /** The focused tab's handle, or null when the focus is on something else. */
  const active = computed(() => (activePanel.value ? handles.get(activePanel.value.id) ?? null : null))

  function register(id: string, handle: QueryPanelHandle) {
    handles.set(id, handle)
    return () => { handles.delete(id) }
  }

  /** A script from disk lands in a new tab named after the file. */
  function openText(path: string, content: string) {
    rememberFile(path)

    openQuery({
      connectionId: activeId.value,
      sql: content,
      title: fileName(path),
      filePath: path,
    })
  }

  /** File › Open: asks which script, then opens it. */
  async function openSqlFile() {
    if (!isAvailable.value) return

    const picked = await bridge().openFile({
      read: true,
      filters: [{ name: 'SQL', extensions: ['sql'] }, { name: 'All files', extensions: ['*'] }],
    })

    if (!picked.opened || !picked.path) return

    openText(picked.path, picked.content ?? '')
  }

  /**
   * File › Recent: a script whose path is already known, so no dialog. The
   * main process reads the file when the request carries a path; a file that
   * has since been moved or deleted comes back unopened and leaves the list,
   * because a menu row that fails every time is worse than none.
   */
  async function openRecent(path: string) {
    if (!isAvailable.value) return

    try {
      const picked = await bridge().openFile({ read: true, path })

      if (!picked.opened || !picked.path) {
        forgetFile(path)
        return
      }

      openText(picked.path, picked.content ?? '')
    }
    catch {
      forgetFile(path)
    }
  }

  return { active, register, openSqlFile, openRecent, rememberFile }
}

/** The last segment of a path, whichever way its separators lean. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}
