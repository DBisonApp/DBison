/**
 * Strips Vue reactivity from a value before it crosses the IPC bridge.
 *
 * Anything read out of `useState`/`reactive` is a Proxy, and Electron's
 * structured clone rejects Proxy objects outright ("An object could not be
 * cloned"). Reading through the traps with a JSON round trip yields the plain
 * data underneath, and also drops functions and `undefined` entries that would
 * fail to clone for the same reason.
 *
 * Every IPC payload in this app is JSON-shaped — profiles, node references,
 * query options — so nothing is lost. Do not route Dates, Maps or typed arrays
 * through here; they would come out the other side as strings or `{}`.
 */
export function toPlain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value

  return JSON.parse(JSON.stringify(value)) as T
}
