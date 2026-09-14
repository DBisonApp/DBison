/**
 * Runs `smoke-server.mjs` against a connection the app has saved, with the
 * password from the OS keychain — so under Electron, never plain node:
 *
 *   PG_PROFILE="elementarium-dev" electron smoke-server-profile.mjs
 *   MYSQL_PROFILE="local mysql" electron smoke-server-profile.mjs
 *
 * The profile's database is used for exactly one statement: creating the
 * scratch database `dbison_smoke_db`. Every other statement runs in that
 * database, which is dropped at the end.
 */
import path from 'node:path'

import { app } from 'electron'

import { ConnectionStore } from './electron/connection-store.js'
import { failureCount, smoke } from './smoke-server.mjs'

// The keychain key lives in the app's own user-data folder (Chromium's
// "Local State"), so this has to be the app's folder before the app is ready.
app.setName('dbison')
app.setPath('userData', path.join(app.getPath('appData'), 'dbison'))

const WANTED = [
  ['postgres', process.env.PG_PROFILE],
  ['mysql', process.env.MYSQL_PROFILE],
].filter(([, name]) => name)

app.whenReady().then(async () => {
  if (!WANTED.length) {
    console.error('Set PG_PROFILE and/or MYSQL_PROFILE to the name of a saved connection.')
    app.exit(2)
    return
  }

  const store = new ConnectionStore()
  await store.load()

  for (const [driverId, name] of WANTED) {
    const profile = store.list().find((entry) => entry.name === name)

    if (!profile) {
      console.error(`No saved connection named "${name}". Saved: ${store.list().map((entry) => entry.name).join(', ')}`)
      app.exit(2)
      return
    }

    if (profile.driver !== driverId && !(driverId === 'mysql' && profile.driver === 'mariadb')) {
      console.error(`"${name}" is a ${profile.driver} connection, not ${driverId}.`)
      app.exit(2)
      return
    }

    const secret = store.secretFor(profile.id)
    console.log(`target [${driverId}] ${profile.username}@${profile.host}:${profile.port}/${profile.database} (password ${secret ? 'from keychain' : 'none'})`)

    await smoke(profile.driver, { profile: store.get(profile.id), secret })
  }

  const failures = failureCount()
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
  app.exit(failures ? 1 : 0)
}).catch((error) => {
  console.error('SMOKE FAILED:', error)
  app.exit(1)
})
