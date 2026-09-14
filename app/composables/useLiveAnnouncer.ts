/**
 * What a screen reader is told about things that only changed visually.
 *
 * A copy confirmation, a row count, an error banner: each appears somewhere
 * on screen and is never spoken, because nothing marked the region as live.
 * Rather than mark every such element, the views call `announce` and one
 * hidden region in the shell carries the message. Errors go through the
 * assertive channel so they interrupt; everything else waits its turn.
 */
export function useLiveAnnouncer() {
  const polite = useState('announce-polite', () => '')
  const assertive = useState('announce-assertive', () => '')

  function announce(message: string, tone: 'polite' | 'assertive' = 'polite') {
    const channel = tone === 'assertive' ? assertive : polite

    // A repeated message would be read once: the region only announces a
    // change. Clearing first makes the same words a change again.
    channel.value = ''
    nextTick(() => { channel.value = message })
  }

  return { polite: readonly(polite), assertive: readonly(assertive), announce }
}
