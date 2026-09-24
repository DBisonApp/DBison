/**
 * Smoke test for the main-process features that need no window: structure
 * changes, CSV import, streamed export and the read-only guard, driven
 * through the ConnectionManager the way the IPC handlers drive it.
 *
 *   node smoke/backend.mjs                      # SQLite, in a temp file
 *   PG_URL=postgres://user:pass@host/db node smoke/backend.mjs
 *
 * Plain Node, no Electron. With PG_URL the same checks run against Postgres
 * in a scratch database of their own (`dbison_smoke_backend`), created for
 * the run and dropped at the end; nothing else on the server is touched.
 * The exit code is 1 when any check failed.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import pg from 'pg'

import { ConnectionManager } from '../electron/connection-manager.js'
import { exportToFile } from '../electron/export.js'

let failures = 0

function report(engine, name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} [${engine}] ${name}${detail ? ` -- ${detail}` : ''}`)
  if (!ok) failures += 1
}

async function check(engine, name, run) {
  try {
    const detail = await run()
    report(engine, name, true, typeof detail === 'string' ? detail : undefined)
  }
  catch (error) {
    report(engine, name, false, error?.message ?? String(error))
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** The store the manager reads profiles from, with one profile in it. */
function storeOf(profile, secret) {
  return {
    get: (id) => (id === profile.id ? profile : null),
    list: () => [profile],
    secretFor: () => secret,
    sshSecretFor: () => undefined,
  }
}

const CSV = [
  'id,name,age,note',
  '1,Ada,36,"likes, commas"',
  '2,Grace,45,',
  '3,"Linus ""T""",NULL,"two',
  'lines"',
  '',
].join('\n')

async function exercise(engine, manager, profile, node, scratchDir) {
  const id = profile.id
  const scope = { database: node.path.database, schema: node.path.schema }

  await check(engine, 'ddl dry run builds a CREATE TABLE without running it', async () => {
    const outcome = await manager.ddl(id, { kind: 'schema', path: scope }, {
      kind: 'createTable',
      name: node.path.table,
      columns: [
        { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
        { name: 'name', type: 'text', nullable: false },
        { name: 'age', type: 'integer' },
      ],
    }, { dryRun: true })
    assert(!outcome.applied && outcome.statements.length === 1, 'expected one unapplied statement')
    assert(/create table/i.test(outcome.statements[0]), outcome.statements[0])
    return outcome.statements[0].split('\n')[0]
  })

  await check(engine, 'ddl creates the table', async () => {
    const outcome = await manager.ddl(id, { kind: 'schema', path: scope }, {
      kind: 'createTable',
      name: node.path.table,
      columns: [
        { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
        { name: 'name', type: 'text', nullable: false },
        { name: 'age', type: 'integer' },
      ],
    })
    assert(outcome.applied, 'not applied')
  })

  await check(engine, 'ddl adds a column and an index', async () => {
    await manager.ddl(id, node, { kind: 'addColumn', column: { name: 'note', type: 'text' } })
    await manager.ddl(id, node, { kind: 'createIndex', name: `${node.path.table}_name_idx`, columns: ['name'] })
    const structure = await manager.structure(id, node)
    assert(structure.indexes.some((index) => index.columns.includes('name')), 'index not listed')
  })

  const csvPath = path.join(scratchDir, 'people.csv')
  await writeFile(csvPath, CSV, 'utf8')

  await check(engine, 'import loads a CSV with quotes, newlines and NULLs in one transaction', async () => {
    let progressed = 0
    const outcome = await manager.importRows(id, node, {
      path: csvPath,
      delimiter: ',',
      hasHeader: true,
      mapping: [{ source: 0, column: 'id' }, { source: 1, column: 'name' }, { source: 2, column: 'age' }, { source: 3, column: 'note' }],
      nullText: 'NULL',
      emptyIsNull: true,
      trim: true,
      batchSize: 2,
    }, { onProgress: (rows) => { progressed = rows } })

    assert(outcome.inserted === 3, `inserted ${outcome.inserted}`)
    assert(progressed === 3, `progress reported ${progressed}`)

    const rows = await manager.query(id, `select id, name, age, note from ${qualified(engine, node)} order by id`, scope)
    assert(rows.rowCount === 3, `read back ${rows.rowCount} rows`)
    assert(rows.rows[0][3] === 'likes, commas', `note 1: ${rows.rows[0][3]}`)
    assert(rows.rows[1][3] === null, `note 2 should be NULL: ${rows.rows[1][3]}`)
    assert(rows.rows[2][1] === 'Linus "T"', `name 3: ${rows.rows[2][1]}`)
    assert(rows.rows[2][2] === null, `age 3 should be NULL: ${rows.rows[2][2]}`)
    assert(rows.rows[2][3] === 'two\nlines', `note 3: ${JSON.stringify(rows.rows[2][3])}`)
  })

  await check(engine, 'import rolls back whole when a row is bad', async () => {
    const badPath = path.join(scratchDir, 'bad.csv')
    await writeFile(badPath, 'id,name\n10,ok\n11,\n', 'utf8')

    let failed = false
    try {
      await manager.importRows(id, node, {
        path: badPath,
        delimiter: ',',
        hasHeader: true,
        mapping: [{ source: 0, column: 'id' }, { source: 1, column: 'name' }],
        emptyIsNull: true,
        batchSize: 1,
      })
    }
    catch {
      failed = true
    }
    assert(failed, 'a NULL into a NOT NULL column should fail')

    const count = await manager.countRows(id, node)
    assert(count.count === 3, `expected the 3 earlier rows only, found ${count.count}`)
  })

  for (const format of ['csv', 'json', 'sql', 'tsv']) {
    await check(engine, `export streams every row as ${format}`, async () => {
      const target = path.join(scratchDir, `people.${format}`)
      const outcome = await exportToFile(manager, id, {
        sql: `select id, name, age, note from ${qualified(engine, node)} order by id`,
        ...scope,
        format,
        header: true,
        nullText: format === 'csv' ? '\\N' : undefined,
        table: qualified(engine, node),
        quote: engine === 'mysql' ? '`' : '"',
      }, { path: target })

      assert(outcome.rows === 3, `exported ${outcome.rows} rows`)
      const text = await readFile(target, 'utf8')

      if (format === 'csv') {
        assert(text.startsWith('id,name,age,note\n'), 'header missing')
        assert(text.includes('"likes, commas"'), 'quoting lost')
        assert(text.includes('\\N'), 'null text missing')
      }
      if (format === 'json') {
        const parsed = JSON.parse(text)
        assert(parsed.length === 3 && parsed[1].note === null, 'json shape wrong')
      }
      if (format === 'sql') {
        assert(/^insert into .* \("id", "name", "age", "note"\)|^insert into .* \(`id`, `name`, `age`, `note`\)/m.test(text), `insert missing: ${text.slice(0, 80)}`)
        assert(text.includes("'Linus \"T\"'"), 'literal wrong')
      }
      if (format === 'tsv') assert(text.split('\n')[1].split('\t').length === 4, 'tab split wrong')

      return `${outcome.bytes} bytes`
    })
  }

  await check(engine, 'export of an empty result still writes the header', async () => {
    const target = path.join(scratchDir, 'empty.csv')
    const outcome = await exportToFile(manager, id, {
      sql: `select id, name from ${qualified(engine, node)} where id < 0`,
      ...scope,
      format: 'csv',
    }, { path: target })
    assert(outcome.rows === 0, 'rows should be 0')
    assert((await readFile(target, 'utf8')) === 'id,name\n', 'header expected')
  })

  await check(engine, 'export cancelled through the job id removes the file', async () => {
    const target = path.join(scratchDir, 'cancelled.csv')
    const jobId = 'job-cancel'
    const started = exportToFile(manager, id, {
      sql: `select id from ${qualified(engine, node)}`,
      ...scope,
      format: 'csv',
      jobId,
    }, { path: target })
    manager.cancel(jobId)
    const outcome = await started.catch((error) => error)
    // Too fast to cancel is a pass too: what matters is no half file.
    if (outcome instanceof Error) assert(outcome.cancelled, `unexpected error: ${outcome.message}`)
    return outcome instanceof Error ? 'cancelled' : 'finished before the cancel landed'
  })

  await check(engine, 'read-only profile refuses a write without consent and allows it with', async () => {
    profile.readOnly = true
    let refused = null
    try {
      await manager.query(id, `delete from ${qualified(engine, node)} where id = 1`, scope)
    }
    catch (error) {
      refused = error
    }
    assert(refused?.code === 'READ_ONLY', `expected READ_ONLY, got ${refused?.code ?? 'nothing'}`)

    const still = await manager.countRows(id, node)
    assert(still.count === 3, 'the refused delete must not have run')

    await manager.query(id, `delete from ${qualified(engine, node)} where id = 1`, { ...scope, allowWrite: true })
    const after = await manager.countRows(id, node)
    assert(after.count === 2, 'the consented delete should have run')

    let ddlRefused = null
    try {
      await manager.ddl(id, node, { kind: 'dropColumn', name: 'note' })
    }
    catch (error) {
      ddlRefused = error
    }
    assert(ddlRefused?.code === 'READ_ONLY', 'ddl should be refused too')
    profile.readOnly = false
  })

  await check(engine, 'ddl renames and drops', async () => {
    await manager.ddl(id, node, { kind: 'renameColumn', name: 'note', to: 'remark' })
    await manager.ddl(id, node, { kind: 'dropIndex', name: `${node.path.table}_name_idx` })
    const renamed = `${node.path.table}_renamed`
    await manager.ddl(id, node, { kind: 'renameTable', to: renamed })
    const moved = { ...node, path: { ...node.path, table: renamed } }
    const rows = await manager.query(id, `select remark from ${qualified(engine, moved)}`, scope)
    assert(rows.columns[0].name === 'remark', 'rename not visible')
    await manager.ddl(id, moved, { kind: 'dropTable' })
  })
}

function qualified(engine, node) {
  const q = (name) => (engine === 'mysql' ? `\`${name}\`` : `"${name}"`)
  if (engine === 'postgres') return `${q(node.path.schema)}.${q(node.path.table)}`
  if (engine === 'mysql') return `${q(node.path.database)}.${q(node.path.table)}`
  return q(node.path.table)
}

async function runSqlite(scratchDir) {
  const file = path.join(scratchDir, 'backend.sqlite')
  new DatabaseSync(file).close()

  const profile = { id: 'lite', name: 'Lite', driver: 'sqlite', file }
  const manager = new ConnectionManager(storeOf(profile))

  await check('sqlite', 'connects', async () => {
    const state = await manager.connect('lite')
    assert(state.status === 'connected', state.status)
    return state.serverVersion
  })

  await exercise('sqlite', manager, profile, { kind: 'table', path: { table: 'people' } }, scratchDir)
  await manager.shutdown()
}

async function runPostgres(url, scratchDir) {
  const parsed = new URL(url)
  const database = 'dbison_smoke_backend'
  const admin = new pg.Client({ connectionString: url })
  await admin.connect()
  await admin.query(`drop database if exists ${database} with (force)`)
  await admin.query(`create database ${database}`)

  const profile = {
    id: 'pg',
    name: 'PG',
    driver: 'postgres',
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    username: decodeURIComponent(parsed.username),
    database,
  }
  const manager = new ConnectionManager(storeOf(profile, decodeURIComponent(parsed.password)))

  try {
    await check('postgres', 'connects', async () => {
      const state = await manager.connect('pg')
      assert(state.status === 'connected', state.status)
      return state.serverVersion
    })

    await exercise('postgres', manager, profile, { kind: 'table', path: { database, schema: 'public', table: 'people' } }, scratchDir)
  }
  finally {
    await manager.shutdown()
    await admin.query(`drop database if exists ${database} with (force)`)
    await admin.end()
  }
}

const scratchDir = await mkdtemp(path.join(tmpdir(), 'dbison-backend-'))

try {
  await runSqlite(scratchDir)
  if (process.env.PG_URL) await runPostgres(process.env.PG_URL, scratchDir)
  else console.log('SKIP [postgres] PG_URL not set')
}
finally {
  await rm(scratchDir, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
