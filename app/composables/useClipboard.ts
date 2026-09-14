/**
 * Copying to the clipboard, with the short-lived confirmation that makes it
 * believable.
 *
 * A copy is invisible: nothing on screen changes, and the user finds out
 * whether it worked by pasting somewhere else. The notice is the whole point of
 * the composable — the `navigator.clipboard` call on its own is one line.
 *
 * Each caller gets its own notice, shown wherever that view already has room
 * for one, rather than a single app-wide toast layer.
 */
export function useClipboard() {
  const notice = ref('')
  const { announce } = useLiveAnnouncer()
  let timer: number | undefined

  function flash(message: string) {
    notice.value = message
    announce(message)
    window.clearTimeout(timer)
    timer = window.setTimeout(() => { notice.value = '' }, 2400)
  }

  /** `what` completes the sentence "Copied …": "the cell", "3 columns". */
  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text)
      flash(`Copied ${what}`)
    }
    catch {
      flash('Could not reach the clipboard')
    }
  }

  onBeforeUnmount(() => window.clearTimeout(timer))

  return { notice, flash, copy }
}
