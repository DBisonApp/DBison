/**
 * The one place a keystroke is written down.
 *
 * The menu used to print `Ctrl+N` next to "New Query" while nothing anywhere
 * listened for Ctrl+N — there was no global key handler in the app at all. The
 * fix is not to add one beside the menu but to make them the same fact: a
 * command carries its `keys` string, `useShortcuts` is what matches it, and
 * `AppMenuBar` prints it. A hint can then only be wrong if the shortcut is.
 */

/** True on macOS, where the Ctrl in a shortcut string means Command. */
const IS_MAC = import.meta.client && /mac/i.test(navigator.platform)

export interface Combo {
  ctrl: boolean
  shift: boolean
  alt: boolean
  key: string
}

/** `'Ctrl+Shift+N'` → the parts a keydown event is compared against. */
export function parseKeys(keys: string): Combo {
  const parts = keys.split('+').map((part) => part.trim())

  return {
    ctrl: parts.includes('Ctrl'),
    shift: parts.includes('Shift'),
    alt: parts.includes('Alt'),
    key: (parts.at(-1) ?? '').toLowerCase(),
  }
}

/**
 * How the keystroke is drawn in a menu.
 *
 * Ctrl is matched against the Command key on macOS, so it has to be printed as
 * one there too; a Mac user reading "Ctrl+N" would press the wrong key.
 */
export function formatKeys(keys: string): string {
  return IS_MAC ? keys.replace(/Ctrl\+/g, '⌘').replace(/Shift\+/g, '⇧').replace(/Alt\+/g, '⌥') : keys
}

function matches(combo: Combo, event: KeyboardEvent): boolean {
  // Command stands in for Ctrl on macOS, and is the only place metaKey counts:
  // a stray Windows-key press must not fire a Ctrl shortcut.
  const ctrl = IS_MAC ? event.metaKey : event.ctrlKey

  return combo.ctrl === ctrl
    && combo.shift === event.shiftKey
    && combo.alt === event.altKey
    && combo.key === event.key.toLowerCase()
}

function isEditable(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element?.tagName) return false

  return element.isContentEditable
    || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)
}

export interface Shortcut {
  keys?: string
  disabled?: boolean
  run: () => void
}

/**
 * Binds a list of commands to the window for as long as the caller is mounted.
 *
 * The list is a getter rather than a snapshot so a command that becomes enabled
 * — the first connection is saved, a tab opens — starts working without the
 * binding being torn down and rebuilt.
 */
export function useShortcuts(shortcuts: () => Shortcut[]) {
  function onKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.repeat) return

    for (const shortcut of shortcuts()) {
      if (!shortcut.keys) continue

      const combo = parseKeys(shortcut.keys)

      // An unmodified key belongs to whatever the user is typing into; only a
      // chord is safe to steal from a field. A function key is the exception:
      // F5 types nothing, and a refresh asked for from inside the filter box
      // is still a refresh.
      if (!combo.ctrl && !combo.alt && !/^f\d{1,2}$/.test(combo.key) && isEditable(event.target)) continue
      if (!matches(combo, event)) continue

      // Claimed either way: a disabled command still owns its keystroke, and
      // letting it through would hand Ctrl+W to Electron and close the window.
      event.preventDefault()
      if (!shortcut.disabled) shortcut.run()
      return
    }
  }

  onMounted(() => window.addEventListener('keydown', onKeydown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
}
