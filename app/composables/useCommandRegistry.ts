import type { IconName } from '~/components/ui/AppIcon.vue'

/**
 * A thing the app can do, named so the palette can list it.
 *
 * The menu bar is the first source: every row it draws is a command, with its
 * keystroke. Other views add their own for as long as they are mounted — a
 * query tab contributes "Run", the explorer contributes each table — and take
 * them back on unmount, so the palette never offers a stale command.
 */
export interface AppCommand {
  id: string
  label: string
  /** Where it lives, for the dimmed prefix: "File", "Table", "Connection". */
  group?: string
  icon?: IconName
  keys?: string
  disabled?: boolean
  /** Extra words the search may match on, beyond the label. */
  keywords?: string
  run: () => void
}

type Source = () => AppCommand[]

/** Module-level on purpose: dockview mounts panels outside the app tree. */
const sources = shallowReactive(new Map<string, Source>())

export function useCommandRegistry() {
  /** Registers a live source; the return value removes it. */
  function register(key: string, source: Source) {
    sources.set(key, source)
    return () => { sources.delete(key) }
  }

  /** Every command from every mounted source, in registration order. */
  const commands = computed(() => [...sources.values()].flatMap((source) => source()))

  return { register, commands }
}
