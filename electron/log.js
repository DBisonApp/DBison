import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import path from 'node:path'

import { app } from 'electron'

const FILE_NAME = 'dbison.log'
/** Past this the file is rolled to `.1` and started again: a log, not an archive. */
const ROLL_AT_BYTES = 2 * 1024 * 1024

let file
let writing = Promise.resolve()

/**
 * The app's log file, under the user's data directory.
 *
 * A packaged app launched from an icon has no terminal: whatever the main
 * process prints goes nowhere, and a renderer error in a window the user is
 * not looking at is simply silence. Both sides write here instead, one line
 * per event, so "it did something odd yesterday" has somewhere to look.
 *
 * Nothing sensitive is written on purpose — messages and stack traces, never
 * a statement's parameters or a profile's secrets — and nothing here can
 * fail loudly: a log that cannot be written is not worth an error of its own.
 */
export function logPath() {
  file ??= path.join(app.getPath('logs'), FILE_NAME)
  return file
}

function line(level, message, detail) {
  const stamp = new Date().toISOString()
  const head = `${stamp} ${level.toUpperCase().padEnd(5)} ${String(message).replace(/\r?\n/g, ' ⏎ ')}`
  if (!detail) return `${head}\n`

  // Multi-line detail is indented under its line so a stack trace still reads
  // as one entry when the file is scanned by eye.
  const body = String(detail).split(/\r?\n/).map((part) => `    ${part}`).join('\n')
  return `${head}\n${body}\n`
}

async function roll(target) {
  try {
    const info = await stat(target)
    if (info.size < ROLL_AT_BYTES) return
    await rename(target, `${target}.1`)
  }
  catch {
    // A missing file is a first write; a rename that fails leaves the file
    // growing, which is the lesser problem.
  }
}

/**
 * @param {'error' | 'warn' | 'info'} level
 * @param {string} message
 * @param {string} [detail]  A stack trace, or whatever explains the line.
 */
export function log(level, message, detail) {
  const target = logPath()
  const text = line(level, message, detail)

  // Serialized so two entries never interleave mid-line, and so a roll
  // finishes before the next append.
  writing = writing
    .then(async () => {
      await mkdir(path.dirname(target), { recursive: true })
      await roll(target)
      await appendFile(target, text, 'utf8')
    })
    .catch(() => {})

  // Mirrored to the terminal while developing, where it is the faster read.
  if (!app.isPackaged) {
    const print = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    print(`[dbison] ${message}${detail ? `\n${detail}` : ''}`)
  }

  return writing
}

/** An error's worth of detail: the stack when there is one, the message otherwise. */
export function describeError(error) {
  if (error instanceof Error) return error.stack ?? error.message
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error)
    }
    catch {
      return String(error)
    }
  }
  return String(error)
}

/**
 * Catches what nothing else did in the main process. Logged rather than
 * rethrown: Electron would show a dialog and exit, taking every open
 * connection's staged work with it, for what is usually a driver's late
 * rejection after a disconnect.
 */
export function installProcessHandlers() {
  process.on('uncaughtException', (error) => {
    log('error', `Uncaught exception: ${error?.message ?? error}`, describeError(error))
  })

  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason)
    log('error', `Unhandled rejection: ${message}`, describeError(reason))
  })
}
