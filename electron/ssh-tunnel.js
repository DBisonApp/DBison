import { readFileSync } from 'node:fs'
import net from 'node:net'

import { Client } from 'ssh2'

/** How long the handshake and authentication together may take. */
const READY_TIMEOUT_MS = 15_000

/**
 * A NAT or firewall drops a TCP connection nothing has spoken on for a few
 * minutes; a keepalive every fifteen seconds is well inside every such
 * timeout, and costs nothing on a session that is being used anyway.
 */
const KEEPALIVE_INTERVAL_MS = 15_000

/**
 * Reads the private key a profile names. A path that cannot be read is the
 * user's to fix, so the error names the file rather than letting the SSH
 * layer fail later with a complaint about key formats.
 */
function readKey(keyPath) {
  try {
    return readFileSync(keyPath)
  }
  catch (error) {
    throw new Error(`Cannot read the SSH key at ${keyPath}.`, { cause: error })
  }
}

/**
 * Opens an SSH connection and a local port that leads through it to
 * `targetHost:targetPort`, as the SSH server sees them.
 *
 * The database drivers know nothing of this: they are handed 127.0.0.1 and
 * the port returned here, and dial it like any other server. Each connection
 * they open becomes one forwarded channel on the SSH session; the pool's
 * connections, the cancel connection Postgres opens out of band, all of
 * them travel the same tunnel.
 *
 * `secret` is the password, or the key's passphrase when `keyPath` is set;
 * a key without a passphrase simply ignores it.
 *
 * @param {{
 *   host: string,
 *   port?: number,
 *   username?: string,
 *   keyPath?: string,
 *   secret?: string,
 *   targetHost: string,
 *   targetPort: number,
 * }} options
 * @returns {Promise<{ localPort: number, close: () => Promise<void> }>}
 */
export async function openTunnel({ host, port = 22, username, keyPath, secret, targetHost, targetPort }) {
  if (!host) throw new Error('The SSH host is missing from this connection.')

  // Read before anything is dialled, so a bad path fails fast and by name.
  const privateKey = keyPath ? readKey(keyPath) : undefined
  const client = new Client()

  await new Promise((resolve, reject) => {
    const fail = (reason) => reject(new Error(`SSH to ${host}: ${reason.message}`, { cause: reason }))
    // A server that drops the socket during the handshake — a banner it
    // dislikes, a rate limit — can close without an error event first.
    const closed = () => fail(new Error('the connection closed before it was ready.'))

    client.on('error', fail)
    client.on('close', closed)
    client.once('ready', () => {
      // From here on an error means the session died under a live tunnel.
      // It is only observed, never thrown: with no listener at all the
      // emitter would take the whole process down, and the drivers learn of
      // it anyway when their sockets close, which the manager reads as a
      // lost connection.
      client.off('error', fail)
      client.off('close', closed)
      client.on('error', () => {})
      resolve()
    })

    client.connect({
      host,
      port,
      username,
      ...(privateKey
        ? { privateKey, passphrase: secret || undefined }
        : { password: secret }),
      readyTimeout: READY_TIMEOUT_MS,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
    })
  })

  const sockets = new Set()

  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    // A driver closing its side abruptly is not news worth crashing over.
    socket.on('error', () => {})

    client.forwardOut('127.0.0.1', socket.localPort ?? 0, targetHost, targetPort, (error, stream) => {
      if (error) {
        // The far end refused, which the driver sees as its socket closing:
        // the same thing it would have seen dialling a dead server directly.
        socket.destroy()
        return
      }

      stream.on('error', () => socket.destroy())
      stream.on('close', () => socket.destroy())
      socket.pipe(stream).pipe(socket)
    })
  })

  // A session that dies takes its channels with it; the sockets on this
  // side are ended so the drivers notice rather than wait.
  client.on('close', () => {
    for (const socket of sockets) socket.destroy()
  })

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      // Port 0 asks the OS for any free port; loopback only, so nothing else
      // on the machine can ride the tunnel.
      server.listen(0, '127.0.0.1', resolve)
    })
  }
  catch (error) {
    client.end()
    throw new Error(`SSH to ${host}: could not open a local port for the tunnel (${error.message}).`, { cause: error })
  }

  async function close() {
    for (const socket of sockets) socket.destroy()

    // The callback reports "not running" when closed twice; either way there
    // is nothing left listening, which is all that matters here.
    await new Promise((resolve) => server.close(() => resolve()))
    client.end()
  }

  return { localPort: server.address().port, close }
}
