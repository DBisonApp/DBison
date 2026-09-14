/**
 * How an object in a server is addressed from the renderer.
 *
 * The id is the only handle a panel keeps on a node — it is what dedupes an
 * already-open table tab, and what a restored layout comes back with — so it
 * has to be the same string no matter which side built it. The navigator's
 * lazily-expanded nodes are stamped in `electron/connection-manager.js`; the
 * explorer builds its own from a schema snapshot, which never crosses that
 * code path. Both call this.
 *
 * Plain JS (not TS) for the same reason as `shared/ipc-channels.js`: the main
 * process runs these files without a build step.
 */

/**
 * @param {string} connectionId
 * @param {string} kind
 * @param {object} [path] A `DbPath`: the levels that address it, outermost
 *   first. Typed loosely because the id is the values in insertion order and
 *   nothing here cares which level each one was.
 */
export function nodeId(connectionId, kind, path = {}) {
  return `${connectionId}:${kind}:${Object.values(path).join('.')}`
}
