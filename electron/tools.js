import { execFile, spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, constants, readdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** How many of a tool's last lines are kept for the error a failed run reports. */
const TAIL_LINES = 30

/**
 * The engines' own command-line tools, found and run from here.
 *
 * A backup that the engine's own tool wrote is one the engine's own tool can
 * read back, on any machine, with or without this app — which is the whole
 * point of a backup. So nothing is reimplemented: pg_dump, mysqldump and
 * sqlite3 are located on the machine and driven with the connection's own
 * settings, and their output is streamed to the renderer as it comes.
 */

const WINDOWS_EXT = process.platform === 'win32' ? '.exe' : ''

/** Directories the installers use, when the tool is not on PATH. */
async function candidateDirectories(tool) {
  const dirs = []

  if (process.platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432].filter(Boolean)
    for (const root of new Set(roots)) {
      if (tool.startsWith('pg') || tool === 'psql') dirs.push(...await versionedBins(path.join(root, 'PostgreSQL')))
      if (tool.startsWith('mysql')) {
        dirs.push(...await versionedBins(path.join(root, 'MySQL')))
        dirs.push(...await versionedBins(path.join(root, 'MariaDB')))
        dirs.push(...await versionedBins(root, /^MariaDB/i))
      }
    }
  }
  else if (process.platform === 'darwin') {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin')
    if (tool.startsWith('pg') || tool === 'psql') {
      dirs.push(...await versionedBins('/Applications/Postgres.app/Contents/Versions'))
      dirs.push(...await versionedBins('/Library/PostgreSQL'))
      dirs.push(...await versionedBins('/opt/homebrew/opt', /^postgresql@/))
    }
    if (tool.startsWith('mysql')) dirs.push(...await versionedBins('/usr/local/mysql'))
  }
  else {
    dirs.push('/usr/bin', '/usr/local/bin', '/bin')
    if (tool.startsWith('pg') || tool === 'psql') dirs.push(...await versionedBins('/usr/lib/postgresql'))
  }

  return dirs
}

/** `<root>/<version>/bin` for every version directory under root. */
async function versionedBins(root, match = /./) {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && match.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
      .map((entry) => path.join(root, entry.name, 'bin'))
  }
  catch {
    return []
  }
}

async function exists(file) {
  try {
    await access(file, constants.X_OK)
    return true
  }
  catch {
    return false
  }
}

async function versionOf(file) {
  try {
    const { stdout } = await run(file, ['--version'], { timeout: 5_000, windowsHide: true })
    return String(stdout).trim().split('\n')[0]
  }
  catch {
    return undefined
  }
}

/** Where a tool is on this machine, or null: PATH first, then the usual places. */
export async function locateTool(tool) {
  const name = `${tool}${WINDOWS_EXT}`

  try {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    const { stdout } = await run(finder, [name], { timeout: 5_000, windowsHide: true })
    const found = String(stdout).split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    if (found && await exists(found)) return { path: found, version: await versionOf(found) }
  }
  catch {
    // Not on PATH; the installers' own directories are next.
  }

  for (const dir of await candidateDirectories(tool)) {
    const file = path.join(dir, name)
    if (await exists(file)) return { path: file, version: await versionOf(file) }
  }

  return { path: null }
}

/** Running jobs by id, so a cancel can reach the process. */
const running = new Map()

export function cancelTool(jobId) {
  const child = running.get(jobId)
  if (!child) return false
  child.kill()
  return true
}

/**
 * Runs a tool to completion, streaming its stderr (where the dump tools
 * talk) line by line, and returning how it ended.
 *
 * @param {object} spec
 * @param {string} spec.file  The executable.
 * @param {string[]} spec.args
 * @param {Record<string, string>} [spec.env]
 * @param {string} [spec.stdoutTo]  A file to write stdout into.
 * @param {string} [spec.stdinFrom]  A file to feed stdin from.
 * @param {string} [spec.jobId]
 * @param {(line: string) => void} [spec.onLine]
 */
export function runTool({ file, args, env, stdoutTo, stdinFrom, jobId, onLine }) {
  const started = performance.now()
  const tail = []

  const remember = (line) => {
    if (!line.trim()) return
    tail.push(line)
    if (tail.length > TAIL_LINES) tail.shift()
    onLine?.(line)
  }

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(file, args, {
        env: { ...process.env, ...env },
        stdio: [stdinFrom ? 'pipe' : 'ignore', stdoutTo ? 'pipe' : 'pipe', 'pipe'],
        windowsHide: true,
      })
    }
    catch (error) {
      reject(error)
      return
    }

    if (jobId) running.set(jobId, child)

    let output
    if (stdoutTo) {
      output = createWriteStream(stdoutTo)
      child.stdout.pipe(output)
    }
    else {
      // Without a file the tool's stdout is treated as more of its log.
      lines(child.stdout, remember)
    }

    if (stdinFrom) {
      const input = createReadStream(stdinFrom)
      input.on('error', (error) => {
        remember(`Cannot read ${stdinFrom}: ${error.message}`)
        child.kill()
      })
      input.pipe(child.stdin)
      child.stdin.on('error', () => {})
    }

    lines(child.stderr, remember)

    child.on('error', (error) => {
      if (jobId) running.delete(jobId)
      reject(error)
    })

    child.on('close', (code, signal) => {
      if (jobId) running.delete(jobId)

      const finish = () => resolve({
        ok: code === 0,
        exitCode: code,
        signal: signal ?? undefined,
        durationMs: Math.round(performance.now() - started),
        tail,
      })

      if (output) output.end(finish)
      else finish()
    })
  })
}

/** Calls `onLine` per line of a stream, whatever the chunking. */
function lines(stream, onLine) {
  let rest = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    rest += chunk
    const parts = rest.split(/\r?\n/)
    rest = parts.pop() ?? ''
    for (const part of parts) onLine(part)
  })
  stream.on('end', () => { if (rest) onLine(rest) })
}

/**
 * The command line that dumps or restores one connection, per engine.
 *
 * `dial` is how the tool should reach the server: the tunnel's local end when
 * the connection goes through SSH, the profile's host and port otherwise.
 * Passwords go through the environment, never the command line, where any
 * other process on the machine could read them.
 */
export function commandFor(action, engine, { profile, dial, secret }, request, toolPath) {
  const database = request.database || profile.database
  const env = {}

  if (engine === 'postgres') {
    env.PGPASSWORD = secret ?? ''
    if (profile.ssl) env.PGSSLMODE = profile.sslVerify ? 'verify-full' : 'require'
    if (profile.sslCa) env.PGSSLROOTCERT = profile.sslCa
    if (profile.sslCert) env.PGSSLCERT = profile.sslCert
    if (profile.sslKey) env.PGSSLKEY = profile.sslKey

    const target = ['-h', dial.host, '-p', String(dial.port), '-U', profile.username ?? '', '--no-password']
    if (!database) throw new Error('Pick a database to work on.')

    if (action === 'dump') {
      const args = ['pg_dump', ...target, '-d', database, '--format=plain', '--no-owner', '--no-privileges', '-f', request.path]
      if (request.schemaOnly) args.push('--schema-only')
      if (request.dataOnly) args.push('--data-only')
      for (const table of request.tables ?? []) args.push('-t', table)
      return { tool: 'pg_dump', file: toolPath, args: args.slice(1), env }
    }

    return {
      tool: 'psql',
      file: toolPath,
      args: [...target, '-d', database, '-v', 'ON_ERROR_STOP=1', '-f', request.path],
      env,
    }
  }

  if (engine === 'mysql') {
    env.MYSQL_PWD = secret ?? ''
    const target = ['-h', dial.host, '-P', String(dial.port), '-u', profile.username ?? '', '--protocol=tcp']
    if (profile.ssl) target.push('--ssl-mode=REQUIRED')
    if (!database) throw new Error('Pick a database to work on.')

    if (action === 'dump') {
      const args = [...target, '--single-transaction', '--routines', '--triggers', `--result-file=${request.path}`]
      if (request.schemaOnly) args.push('--no-data')
      if (request.dataOnly) args.push('--no-create-info')
      args.push(database, ...(request.tables ?? []))
      return { tool: 'mysqldump', file: toolPath, args, env }
    }

    return { tool: 'mysql', file: toolPath, args: [...target, database], env, stdinFrom: request.path }
  }

  if (engine === 'sqlite') {
    if (action === 'dump') {
      const command = request.schemaOnly ? '.schema' : '.dump'
      const args = request.tables?.length
        ? [profile.file, `${command} ${request.tables.map((table) => `"${table}"`).join(' ')}`]
        : [profile.file, command]
      return { tool: 'sqlite3', file: toolPath, args, env, stdoutTo: request.path }
    }

    return { tool: 'sqlite3', file: toolPath, args: [profile.file], env, stdinFrom: request.path }
  }

  throw new Error(`No dump tool is known for ${engine}.`)
}
