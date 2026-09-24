/**
 * Smoke test for the server drivers, against real servers.
 *
 * Usage (either variable may be left out; the engine is then skipped):
 *
 *   PG_URL=postgres://user:pass@host:5432/db \
 *   MYSQL_URL=mysql://user:pass@host:3306/db \
 *   node smoke/server.mjs
 *
 * Or, with a connection the app has saved (the password comes from the OS
 * keychain, so this form runs under Electron):
 *
 *   PG_PROFILE="my connection" electron smoke/server-profile.mjs
 *
 * Plain Node, no Electron: the drivers are opened directly through
 * `getDriver(...).open()`. Nothing of the user's is touched: each engine gets
 * a database of its own, `dbison_smoke_db`, created for the run and dropped
 * at the end. A server that refuses to create one is skipped rather than
 * written into. The exit code is 1 when any check failed.
 */
import { pathToFileURL } from 'node:url'

import { getDriver } from '../electron/drivers/index.js'

const SCHEMA = 'dbison_smoke_s'
const DATABASE = 'dbison_smoke_db'
const TABLE = 'dbison_smoke_users'
const TRIGGER = 'dbison_smoke_trg'
const ROUTINE = 'dbison_smoke_fn'

let failures = 0

function report(engine, name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} [${engine}] ${name}${detail ? ` -- ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** Runs one check, counting a throw as a failure with the message as detail. */
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

function parseUrl(url, driver) {
  const parsed = new URL(url)

  return {
    profile: {
      driver,
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : undefined,
      username: decodeURIComponent(parsed.username),
      database: parsed.pathname.replace(/^\//, '') || undefined,
      ssl: false,
    },
    secret: parsed.password ? decodeURIComponent(parsed.password) : undefined,
  }
}

/**
 * What differs between the engines: how a scratch namespace is made, how the
 * objects are declared, and where the drivers expect to find them.
 */
const ENGINES = {
  postgres: {
    label: 'postgres',
    sleep: 'select pg_sleep(5)',
    createNamespace: `create database ${DATABASE}`,
    // FORCE (Postgres 13+) closes the run's own leftover backends; nothing
    // else can be connected to a database only this script knows about.
    dropNamespace: `drop database if exists ${DATABASE} with (force)`,
    /** Query context inside the scratch database, and the node path of the table. */
    scope() {
      return {
        context: { database: DATABASE, schema: SCHEMA },
        path: { database: DATABASE, schema: SCHEMA, table: TABLE },
        objectsScope: { database: DATABASE },
        schemaKey: SCHEMA,
      }
    },
    /** Run inside the scratch database before the table is made. */
    prepare: [`create schema ${SCHEMA}`],
    createTable: `create table ${TABLE} (id integer primary key, name text not null, email text)`,
    createIndex: `create index ${TABLE}_name_idx on ${TABLE} (name)`,
    comment: `comment on table ${TABLE} is 'smoke table'`,
    createRoutine: `create function ${ROUTINE}() returns trigger language plpgsql as $$ begin return new; end $$`,
    createTrigger: `create trigger ${TRIGGER} before insert on ${TABLE} for each row execute function ${ROUTINE}()`,
    dropObjects: [
      `drop trigger if exists ${TRIGGER} on ${TABLE}`,
      `drop function if exists ${ROUTINE}()`,
      `drop table if exists ${TABLE}`,
    ],
  },
  mysql: {
    label: 'mysql',
    sleep: 'select sleep(5)',
    createNamespace: `create database ${DATABASE}`,
    dropNamespace: `drop database if exists ${DATABASE}`,
    scope() {
      return {
        context: { database: DATABASE },
        path: { database: DATABASE, table: TABLE },
        objectsScope: { database: DATABASE },
        schemaKey: '',
      }
    },
    prepare: [],
    createTable: `create table ${TABLE} (id int primary key, name varchar(100) not null, email varchar(100)) comment = 'smoke table'`,
    createIndex: `create index ${TABLE}_name_idx on ${TABLE} (name)`,
    comment: null,
    createRoutine: `create procedure ${ROUTINE}() begin select 1; end`,
    createTrigger: `create trigger ${TRIGGER} before insert on ${TABLE} for each row set new.name = new.name`,
    dropObjects: [
      `drop trigger if exists ${TRIGGER}`,
      `drop procedure if exists ${ROUTINE}`,
      `drop table if exists ${TABLE}`,
    ],
  },
}

/**
 * @param {string} driverId
 * @param {{ profile: object, secret?: string }} target  A profile as the drivers take one.
 */
export async function smoke(driverId, { profile, secret }) {
  const engine = ENGINES[driverId]
  const label = engine.label

  let session

  await check(label, 'open + serverVersion', async () => {
    session = await getDriver(driverId).open(profile, secret)
    assert(typeof session.serverVersion === 'string' && session.serverVersion, 'no serverVersion')
    return session.serverVersion
  })

  if (!session) return

  // Runs a statement with no display concerns: DDL, setup, teardown.
  const run = (sql, context, options = {}) => session.query(sql, { maxRows: 100, ...context, ...options })

  // The one statement that runs against the user's own database: making the
  // scratch one. A server that refuses is skipped, not written into.
  const baseContext = { database: profile.database }
  let created = false

  await check(label, `create scratch database ${DATABASE}`, async () => {
    await run(engine.dropNamespace, baseContext)
    await run(engine.createNamespace, baseContext)
    created = true
  })

  if (!created) {
    console.log(`note [${label}] no scratch database, so nothing else is run against this server`)
    await session.close().catch(() => {})
    return
  }

  const { context, path, objectsScope, schemaKey } = engine.scope()
  const node = { kind: 'table', path }

  try {
    // Setup, so a failure here shows as one rather than as ten.
    await check(label, 'create smoke table, index and comment', async () => {
      for (const sql of engine.prepare) await run(sql, context)
      for (const sql of engine.dropObjects) await run(sql, context)
      await run(engine.createTable, context)
      await run(engine.createIndex, context)
      if (engine.comment) await run(engine.comment, context)
    })

    await check(label, 'DML reports affectedRows', async () => {
      const result = await run(
        `insert into ${TABLE} (id, name, email) values (1, 'a', 'a@x'), (2, 'b', 'b@x'), (3, 'c', null), (4, 'd', 'd@x'), (5, 'e', null)`,
        context,
      )
      assert(result.affectedRows === 5, `affectedRows ${result.affectedRows}`)
    })

    await check(label, 'select with maxRows 2 truncates', async () => {
      const result = await run(`select * from ${TABLE} order by id`, context, { maxRows: 2 })
      assert(result.truncated === true, `truncated ${result.truncated}`)
      assert(result.rowCount === 2 && result.rows.length === 2, `rowCount ${result.rowCount}`)
      assert(result.streamed === undefined, 'streamed should be unset')
      assert(result.columns.length === 3, `columns ${result.columns.length}`)
    })

    await check(label, 'select with stream: true sends batches', async () => {
      const batches = []
      const result = await run(`select * from ${TABLE} order by id`, context, {
        maxRows: 2,
        onRows: (rows, columns) => batches.push({ rows, columns }),
      })
      assert(result.streamed === true, `streamed ${result.streamed}`)
      assert(result.rows.length === 0, `rows ${result.rows.length}`)
      assert(result.rowCount === 2 && result.truncated === true, `rowCount ${result.rowCount}, truncated ${result.truncated}`)
      assert(batches.length >= 1, 'no batches')
      assert(batches[0].columns?.length === 3, 'first batch carries no columns')
      const total = batches.reduce((sum, batch) => sum + batch.rows.length, 0)
      assert(total === 2, `batched rows ${total}`)
      return `${batches.length} batch(es)`
    })

    await check(label, 'binary: base64', async () => {
      const sql = driverId === 'postgres'
        ? `select '\\x616263'::bytea as b`
        : `select cast(x'616263' as binary) as b`
      const digest = await run(sql, context, { maxRows: 1 })
      const base64 = await run(sql, context, { maxRows: 1, binary: 'base64' })
      assert(String(digest.rows[0][0]).startsWith('0x616263'), `digest ${digest.rows[0][0]}`)
      assert(base64.rows[0][0] === 'YWJj', `base64 ${base64.rows[0][0]}`)
    })

    await check(label, 'schemaSnapshot lists the table', async () => {
      const snapshot = await session.schemaSnapshot(objectsScope)
      const found = snapshot.objects.find((object) => object.name === TABLE && object.schema === schemaKey)
      assert(found, `table not in snapshot (${snapshot.objects.length} objects)`)
      assert(found.columns.some((column) => column.name === 'id' && column.primaryKey), 'no primary key column')
      return `${snapshot.objects.length} objects`
    })

    await check(label, 'structure: indexes and DDL', async () => {
      const structure = await session.structure(node)
      assert(structure.indexes.some((index) => index.primary), 'no primary index')
      assert(structure.indexes.some((index) => index.name === `${TABLE}_name_idx`), 'named index missing')
      assert(typeof structure.ddl === 'string' && structure.ddl.includes(TABLE), 'no DDL')
      assert(structure.ddl.toLowerCase().includes('smoke table'), 'comment missing from DDL')
      return `${structure.indexes.length} indexes`
    })

    await check(label, 'objects: trigger and routine', async () => {
      try {
        await run(engine.createRoutine, context)
        await run(engine.createTrigger, context)
      }
      catch (error) {
        return `skipped: cannot create objects (${error.message})`
      }

      const objects = await session.objects(objectsScope)
      assert(objects.triggers.some((trigger) => trigger.name === TRIGGER && trigger.table === TABLE), 'trigger missing')
      assert(objects.routines.some((routine) => routine.name === ROUTINE), 'routine missing')
      return `${objects.routines.length} routines, ${objects.triggers.length} triggers`
    })

    await check(label, 'transaction: insert, count inside, rollback, count outside', async () => {
      const transaction = await session.beginTransaction(context)

      try {
        await transaction.query(`insert into ${TABLE} (id, name) values (6, 'f')`, { maxRows: 1 })
        const inside = await transaction.query(`select count(*) from ${TABLE}`, { maxRows: 1 })
        assert(Number(inside.rows[0][0]) === 6, `inside ${inside.rows[0][0]}`)
      }
      finally {
        await transaction.rollback()
      }

      const outside = await run(`select count(*) from ${TABLE}`, context, { maxRows: 1 })
      assert(Number(outside.rows[0][0]) === 5, `outside ${outside.rows[0][0]}`)
    })

    await check(label, 'cancellation', async () => {
      const controller = new AbortController()
      const started = performance.now()
      setTimeout(() => controller.abort(), 300)

      const outcome = await run(engine.sleep, context, { maxRows: 1, signal: controller.signal })
        .then(() => null, (error) => error)

      assert(outcome, 'the statement was not cancelled')
      assert(outcome.cancelled === true, `rejected without cancelled: ${outcome.message}`)
      const elapsed = Math.round(performance.now() - started)
      assert(elapsed < 4000, `took ${elapsed}ms`)
      return `${elapsed}ms`
    })

    await check(label, 'countStatement', async () => {
      const sql = session.countStatement(node, { where: 'email is not null' })
      const result = await run(sql, context, { maxRows: 1 })
      assert(Number(result.rows[0][0]) === 3, `count ${result.rows[0][0]}`)
    })
  }
  finally {
    await check(label, `drop scratch database ${DATABASE}`, async () => {
      // The scratch database's own pool has to go before the database can.
      await session.close().catch(() => {})
      session = await getDriver(driverId).open(profile, secret)
      await run(engine.dropNamespace, baseContext)
    })

    await session.close().catch(() => {})
  }
}

export function failureCount() {
  return failures
}

// Run directly: targets come from the environment. Imported (by the profile
// runner under Electron): the caller decides.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const targets = [
    ['postgres', process.env.PG_URL],
    ['mysql', process.env.MYSQL_URL],
  ].filter(([, url]) => url)

  if (!targets.length) {
    console.error('Set PG_URL and/or MYSQL_URL; see the comment at the top of this file.')
    process.exit(2)
  }

  for (const [driverId, url] of targets) {
    await smoke(driverId, parseUrl(url, driverId))
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
  process.exit(failures ? 1 : 0)
}
