/**
 * Whether the command palette is showing.
 *
 * The palette itself is mounted once, in the layout, but the thing that opens
 * it is not: a menu row, a keystroke, a welcome-screen hint can all ask for it.
 * Shared state is what lets each of them flip the same switch without holding
 * a reference to the component.
 */
export function useCommandPalette() {
  const open = useState('command-palette-open', () => false)

  function show() {
    open.value = true
  }

  function hide() {
    open.value = false
  }

  function toggle() {
    open.value = !open.value
  }

  return { open, show, hide, toggle }
}
