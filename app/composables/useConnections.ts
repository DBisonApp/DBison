import type {
  ConnectionProfile,
  ConnectionProfileInput,
  ConnectionState,
  DbNode,
  DriverMeta,
} from '#shared/db-types'

/**
 * The renderer's view of the connection manager that lives in the Electron main
 * process. Nothing here holds a driver handle: profiles are addressed by id and
 * every call crosses the preload bridge.
 */
export function useConnections() {
  const { bridge, isAvailable } = useDatabaseBridge()
  // Taken here rather than inside `importProfiles`: both need the Nuxt
  // instance, which is only reliably at hand while the caller is setting up.
  const { announce } = useLiveAnnouncer()
  const { notice } = useDialogs()

  const profiles = useState<ConnectionProfile[]>('connection-profiles', () => [])
  const states = useState<Record<string, ConnectionState>>('connection-states', () => ({}))
  const drivers = useState<DriverMeta[]>('drivers', () => [])
  const canStoreSecrets = useState('can-store-secrets', () => false)
  const activeId = useState<string | null>('active-connection', () => null)
  const loadError = useState<string | null>('connections-error', () => null)

  const active = computed(() => profiles.value.find((p) => p.id === activeId.value) ?? null)

  function stateOf(id: string): ConnectionState {
    return states.value[id] ?? { id, status: 'disconnected' }
  }

  function driverOf(profile: ConnectionProfile): DriverMeta {
    return (
      drivers.value.find((driver) => driver.id === profile.driver)
      // A profile saved by a build that had a driver this one does not. Its
      // object levels are unknowable, so the query tab offers no pickers.
      ?? { id: profile.driver, label: profile.driver, target: 'server', badge: '??', color: '#888', levels: [], quote: '"' }
    )
  }

  async function refresh() {
    if (!isAvailable.value) {
      loadError.value = 'Running outside the desktop app — no database bridge.'
      return
    }

    try {
      const [catalog, stored] = await Promise.all([bridge().drivers(), bridge().profiles.list()])

      drivers.value = catalog.drivers
      canStoreSecrets.value = catalog.canStoreSecrets
      profiles.value = stored.profiles
      states.value = Object.fromEntries(stored.states.map((state) => [state.id, state]))
      loadError.value = null

      if (!activeId.value || !stored.profiles.some((p) => p.id === activeId.value)) {
        activeId.value = stored.profiles[0]?.id ?? null
      }
    }
    catch (error) {
      loadError.value = error instanceof Error ? error.message : String(error)
    }
  }

  /** Connections mid-reconnect after a drop, so the UI can say so. */
  const reconnecting = useState<Record<string, boolean>>('connections-reconnecting', () => ({}))

  /**
   * One retry, a moment after the drop.
   *
   * A server restart or a flaky link takes the session away in the middle
   * of a query; the stored password makes getting it back automatic. One
   * attempt only: a second failure means something a retry loop would only
   * hide, and the Connect button is right there.
   */
  function reconnectAfterLoss(id: string) {
    if (reconnecting.value[id]) return
    reconnecting.value = { ...reconnecting.value, [id]: true }

    window.setTimeout(async () => {
      try {
        await connect(id)
      }
      catch {
        // The status event already carries the reason; nothing to add.
      }
      finally {
        const { [id]: _done, ...rest } = reconnecting.value
        reconnecting.value = rest
      }
    }, 1_500)
  }

  /** Main pushes here whenever a session opens, fails or closes. */
  function subscribe() {
    if (!isAvailable.value) return () => {}

    return bridge().onStatusChanged((state) => {
      states.value = { ...states.value, [state.id]: state }
      if (state.status === 'error' && state.error?.lost) reconnectAfterLoss(state.id)
    })
  }

  async function connect(id: string, password?: string) {
    // The optimistic status keeps the row from looking idle during a slow
    // handshake; main overwrites it either way through the status event.
    states.value = { ...states.value, [id]: { id, status: 'connecting' } }
    return bridge().connect(id, password)
  }

  async function disconnect(id: string) {
    return bridge().disconnect(id)
  }

  async function save(input: ConnectionProfileInput) {
    const saved = await bridge().profiles.save(input)

    const index = profiles.value.findIndex((p) => p.id === saved.id)
    profiles.value = index === -1
      ? [...profiles.value, saved]
      : profiles.value.toSpliced(index, 1, saved)

    activeId.value = saved.id
    return saved
  }

  /**
   * Moves every connection in one folder to another, or out of folders
   * altogether when `to` is empty. A folder is nothing but the word on its
   * profiles, so renaming or removing one is a save per profile; the active
   * connection is put back afterwards, since each save would otherwise
   * make its own profile the active one.
   */
  async function moveFolder(from: string, to: string | undefined) {
    const active = activeId.value
    const members = profiles.value.filter((p) => (p.folder?.trim() ?? '') === from.trim())

    // Together rather than one after another: each is its own round trip
    // and its own file write, and a folder of ten should not take ten turns.
    await Promise.all(members.map((member) => {
      const { hasStoredPassword: _stored, hasStoredSshSecret: _ssh, ...rest } = member
      return save({ ...rest, folder: to?.trim() || undefined })
    }))

    activeId.value = active
    return members.length
  }

  async function remove(id: string) {
    await bridge().profiles.remove(id)

    profiles.value = profiles.value.filter((p) => p.id !== id)
    if (activeId.value === id) activeId.value = profiles.value[0]?.id ?? null
  }

  async function test(input: ConnectionProfileInput) {
    return bridge().test(input)
  }

  /**
   * Every profile as a JSON file, for another machine or a teammate. Ids stay
   * behind because the importing side mints its own, and passwords are never
   * in the renderer to begin with — the file is safe to send as it is.
   */
  async function exportProfiles() {
    const connections = profiles.value.map(
      ({ id: _id, hasStoredPassword: _password, hasStoredSshSecret: _secret, ...profile }) => profile,
    )

    return bridge().saveFile({
      suggestedName: 'dbison-connections.json',
      content: `${JSON.stringify({ dbison: CONNECTION_EXPORT_VERSION, connections }, null, 2)}\n`,
      filters: [{ name: 'JSON', extensions: ['json'] }, { name: 'All files', extensions: ['*'] }],
    })
  }

  /**
   * Reads connections from a file — an export, a `.pgpass`, a list of URLs —
   * and saves the ones whose names are new. Existing names are left alone
   * rather than overwritten or numbered: importing twice must not turn one
   * "Staging" into two, and a profile a user has tuned should not be replaced
   * by whatever an old file says. The outcome is told twice, once for a screen
   * reader and once in a dialog, since the list itself changes quietly.
   */
  async function importProfiles() {
    const picked = await bridge().openFile({
      read: true,
      filters: [
        { name: 'Connections', extensions: ['json', 'txt', 'pgpass', 'conf'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })

    if (!picked.opened || picked.content === undefined) return null

    const parsed = parseConnectionImport(picked.content)
    const taken = new Set(profiles.value.map((p) => p.name))
    let added = 0
    let existing = 0

    for (const profile of parsed.profiles) {
      if (taken.has(profile.name)) {
        existing += 1
        continue
      }

      await save(profile)
      taken.add(profile.name)
      added += 1
    }

    const parts = [
      `${added} connection${added === 1 ? '' : 's'} imported`,
      existing ? `${existing} already existed` : '',
      parsed.skipped ? `${parsed.skipped} ${parsed.skipped === 1 ? 'entry' : 'entries'} not recognised` : '',
    ].filter(Boolean)
    const summary = `${parts.join(', ')}.`

    announce(summary)
    await notice({ title: 'Import connections', message: summary })

    return { added, existing, skipped: parsed.skipped, source: parsed.source }
  }

  /** Lazily expands one navigator node. */
  async function children(connectionId: string, node: Pick<DbNode, 'kind' | 'path'>) {
    return bridge().children(connectionId, node)
  }

  return {
    profiles,
    drivers,
    canStoreSecrets,
    active,
    activeId,
    loadError,
    isAvailable,
    reconnecting,
    stateOf,
    driverOf,
    refresh,
    subscribe,
    connect,
    disconnect,
    save,
    moveFolder,
    remove,
    test,
    exportProfiles,
    importProfiles,
    children,
  }
}
