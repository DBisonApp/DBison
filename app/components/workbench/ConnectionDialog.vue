<script setup lang="ts">
import { useModalContext } from '@kolirt/vue-modal'
import type { ConnectionProfile, ConnectionProfileInput, DriverId } from '#shared/db-types'

const props = defineProps<{
  profile: ConnectionProfile | null
  /**
   * Start from `profile` but save a new one. The copy gets its own id and
   * none of the original's stored secrets: a password is encrypted for one
   * profile and is not something the renderer can read back to hand over.
   */
  duplicate?: boolean
}>()

defineOptions({ modalGroup: 'dialog' })

// Resolves the `openConnectionDialog()` promise with the saved profile; a
// dismissal (Esc, backdrop, Cancel) rejects it instead.
const { confirm, close } = useModalContext<ConnectionProfile>()

const connections = useConnections()
const { drivers, canStoreSecrets } = connections
const { bridge, isAvailable } = useDatabaseBridge()

const form = reactive<ConnectionProfileInput>({
  name: props.duplicate && props.profile ? `${props.profile.name} copy` : props.profile?.name ?? '',
  driver: props.profile?.driver ?? 'postgres',
  host: props.profile?.host ?? '127.0.0.1',
  port: props.profile?.port,
  database: props.profile?.database ?? '',
  username: props.profile?.username ?? '',
  file: props.profile?.file ?? '',
  ssl: props.profile?.ssl ?? false,
  sslVerify: props.profile?.sslVerify ?? false,
  sslCa: props.profile?.sslCa ?? '',
  sslCert: props.profile?.sslCert ?? '',
  sslKey: props.profile?.sslKey ?? '',
  color: props.profile?.color,
  folder: props.profile?.folder ?? '',
  readOnly: props.profile?.readOnly ?? false,
  noHistory: props.profile?.noHistory ?? false,
  ssh: {
    enabled: props.profile?.ssh?.enabled ?? false,
    host: props.profile?.ssh?.host ?? '',
    port: props.profile?.ssh?.port ?? 22,
    username: props.profile?.ssh?.username ?? '',
    keyPath: props.profile?.ssh?.keyPath ?? '',
  },
  password: '',
  sshPassword: '',
})

/**
 * A short row of tints rather than a colour picker: the point is telling
 * production from staging at a glance, and eight distinct hues do that
 * better than sixteen million similar ones.
 */
const SWATCHES = [
  { color: '#ef4444', name: 'Red' },
  { color: '#f97316', name: 'Orange' },
  { color: '#eab308', name: 'Yellow' },
  { color: '#22c55e', name: 'Green' },
  { color: '#06b6d4', name: 'Cyan' },
  { color: '#3b82f6', name: 'Blue' },
  { color: '#a855f7', name: 'Purple' },
  { color: '#ec4899', name: 'Pink' },
]

const driver = computed(() => drivers.value.find((d) => d.id === form.driver))
const isFileBased = computed(() => driver.value?.target === 'file')

const testing = ref(false)
const saving = ref(false)
const result = ref<{ ok: boolean, message: string } | null>(null)

// Moving between engines should carry the port with it, unless it was typed.
const portTouched = ref(Boolean(props.profile?.port))

watch(
  () => form.driver,
  (next) => {
    const meta = drivers.value.find((d) => d.id === next)
    if (!portTouched.value) form.port = meta?.defaultPort
  },
  { immediate: true },
)

/** A profile with nothing to dial cannot be tested or saved. */
const complete = computed(() => {
  if (!form.name.trim()) return false
  return isFileBased.value ? Boolean(form.file?.trim()) : Boolean(form.host?.trim())
})

/**
 * The folders other profiles already sit in, offered as completions so a
 * second "Production" is spelled like the first. The one being edited is left
 * out: its own folder is already in the box.
 */
const folders = computed(() => {
  const used = connections.profiles.value
    .filter((p) => p.id !== props.profile?.id || props.duplicate)
    .map((p) => p.folder?.trim())
    .filter((folder): folder is string => Boolean(folder))
  return [...new Set(used)].sort((a, b) => a.localeCompare(b))
})
const folderListId = useId()

/** Whether an existing profile is being changed, as opposed to made. */
const editing = computed(() => Boolean(props.profile) && !props.duplicate)

function payload(): ConnectionProfileInput {
  return {
    ...form,
    id: editing.value ? props.profile?.id : undefined,
    name: form.name.trim(),
    folder: form.folder?.trim() || undefined,
    ssh: form.ssh?.enabled ? form.ssh : undefined,
    // Sending an untouched password field would clear a stored one.
    password: form.password ? form.password : undefined,
    sshPassword: form.sshPassword ? form.sshPassword : undefined,
  }
}

/** A private key file for the tunnel. */
async function browseKey() {
  if (!isAvailable.value) return

  const picked = await bridge().openFile({
    filters: [{ name: 'Private keys', extensions: ['pem', 'key', 'ppk', '*'] }],
  }).catch(() => ({ opened: false as const }))

  if (picked.opened && picked.path && form.ssh) form.ssh.keyPath = picked.path
}

async function test() {
  testing.value = true
  result.value = null

  try {
    const outcome = await connections.test(payload())
    result.value = { ok: true, message: `Connected — ${outcome.serverVersion}` }
  }
  catch (error) {
    result.value = { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  finally {
    testing.value = false
  }
}

async function save() {
  saving.value = true
  result.value = null

  try {
    confirm(await connections.save(payload()))
  }
  catch (error) {
    result.value = { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  finally {
    saving.value = false
  }
}

/** The system's file picker, for a path nobody should have to type. */
async function browse() {
  if (!isAvailable.value) return

  const picked = await bridge().openFile({
    filters: [
      { name: 'SQLite databases', extensions: ['sqlite', 'sqlite3', 'db', 'db3', 's3db'] },
      { name: 'All files', extensions: ['*'] },
    ],
  }).catch(() => ({ opened: false as const }))

  if (!picked.opened || !picked.path) return

  form.file = picked.path
  // A file is a name as much as a path; offer it when nothing was typed yet.
  if (!form.name.trim()) form.name = fileName(picked.path).replace(/\.[^.]+$/, '')
}

/**
 * A pasted connection URL fills the form. Kept as a separate box rather than
 * sniffing the Host field: a URL in the wrong box is a mistake to correct,
 * not a gesture to interpret.
 */
const url = ref('')
const urlNote = ref<string | null>(null)

/**
 * The shape of URL each engine hands out, shown as the box's placeholder
 * for the engine picked below. The parser reads any of them; the example
 * only keeps the box from looking like it wants a Postgres URL for a MySQL
 * server.
 */
const URL_EXAMPLES: Record<DriverId, string> = {
  postgres: 'postgres://user:password@host:5432/db?sslmode=require',
  mysql: 'mysql://user:password@host:3306/db',
  mariadb: 'mariadb://user:password@host:3306/db',
  sqlite: 'sqlite:///C:/data/app.sqlite',
}

const urlPlaceholder = computed(() => URL_EXAMPLES[form.driver] ?? URL_EXAMPLES.postgres)

function labelOf(driver: DriverId) {
  return drivers.value.find((option) => option.id === driver)?.label ?? driver
}

function applyUrl() {
  const parsed = parseConnectionUrl(url.value)

  if (!parsed) {
    urlNote.value = url.value.trim() ? 'Not a connection URL for a known engine.' : null
    return
  }

  const switched = parsed.driver && parsed.driver !== form.driver ? parsed.driver : null
  const { password, ...rest } = parsed
  Object.assign(form, rest)
  if (rest.port) portTouched.value = true
  if (password) form.password = password

  const filled = Object.keys(parsed).filter((key) => key !== 'driver')
  const parts = [
    switched ? `switched the engine to ${labelOf(switched)}` : null,
    filled.length ? `filled in ${filled.join(', ')}` : null,
  ].filter(Boolean)
  const note = parts.join(' and ') || 'nothing to fill in'
  urlNote.value = `${note.charAt(0).toUpperCase()}${note.slice(1)}${password ? ' (the password will be stored encrypted)' : ''}.`
  url.value = ''
}

/** A certificate file for one of the three SSL slots. */
async function browseCertificate(slot: 'sslCa' | 'sslCert' | 'sslKey') {
  if (!isAvailable.value) return

  const picked = await bridge().openFile({
    filters: [
      { name: 'Certificates and keys', extensions: ['pem', 'crt', 'cer', 'key'] },
      { name: 'All files', extensions: ['*'] },
    ],
  }).catch(() => ({ opened: false as const }))

  if (picked.opened && picked.path) form[slot] = picked.path
}

const SSL_SLOTS = [
  { key: 'sslCa', label: 'CA certificate', hint: 'Trusts this authority instead of the system roots' },
  { key: 'sslCert', label: 'Client certificate', hint: 'Only when the server asks for one' },
  { key: 'sslKey', label: 'Client key', hint: 'Goes with the client certificate' },
] as const

const fieldClass = 'field py-1.5'
</script>

<template>
  <AppDialog :title="duplicate ? 'Duplicate connection' : editing ? 'Edit connection' : 'New connection'" size="lg">
    <!-- A column with a scrolling middle: the fields may outgrow a small
         window, the buttons must not. Two columns of fields at any width the
         card gets: what the server is on the left, how the app treats it on
         the right. -->
    <form class="flex min-h-0 flex-col" @submit.prevent="save">
      <div class="grid min-h-0 flex-1 gap-x-6 gap-y-3 overflow-y-auto p-4 sm:grid-cols-2">
      <p v-if="duplicate" class="text-faint sm:col-span-2">
        A copy of "{{ profile?.name }}" — its password is not copied, so enter one below if the copy needs it.
      </p>

      <label class="grid gap-1 sm:col-span-2">
        <span class="text-faint">Connection URL <span class="opacity-70">(optional: paste a {{ labelOf(form.driver) }} URL to fill the form)</span></span>
        <span class="flex gap-1">
          <input
            v-model="url"
            :class="fieldClass"
            class="min-w-0 flex-1 font-mono"
            :placeholder="urlPlaceholder"
            spellcheck="false"
            autocomplete="off"
            @keydown.enter.prevent="applyUrl"
            @paste="nextTick(applyUrl)"
          >
          <button type="button" class="btn btn-ghost shrink-0" :disabled="!url.trim()" @click="applyUrl">
            Fill
          </button>
        </span>
        <span v-if="urlNote" class="text-faint">{{ urlNote }}</span>
      </label>

      <div class="grid content-start gap-3">
      <label class="grid gap-1">
        <span class="text-faint">Name</span>
        <input v-model="form.name" :class="fieldClass" placeholder="Staging database" required>
      </label>

      <label class="grid gap-1">
        <span class="text-faint">Engine</span>
        <select v-model="form.driver" :class="fieldClass">
          <option v-for="option in drivers" :key="option.id" :value="option.id as DriverId">
            {{ option.label }}
          </option>
        </select>
      </label>

      <label v-if="isFileBased" class="grid gap-1">
        <span class="text-faint">Database file</span>
        <span class="flex gap-1">
          <input
            v-model="form.file"
            :class="fieldClass"
            class="min-w-0 flex-1"
            placeholder="C:\data\app.sqlite"
            spellcheck="false"
          >
          <button
            type="button"
            class="btn btn-ghost shrink-0"
            :disabled="!isAvailable"
            title="Pick the file"
            @click="browse"
          >
            <AppIcon name="folderOpen" :size="12" />
            Browse…
          </button>
        </span>
      </label>

      <template v-else>
        <div class="grid grid-cols-[1fr_6rem] gap-2">
          <label class="grid gap-1">
            <span class="text-faint">Host</span>
            <input v-model="form.host" :class="fieldClass" spellcheck="false">
          </label>
          <label class="grid gap-1">
            <span class="text-faint">Port</span>
            <input
              v-model.number="form.port"
              type="number"
              :class="fieldClass"
              @input="portTouched = true"
            >
          </label>
        </div>

        <label class="grid gap-1">
          <span class="text-faint">Database</span>
          <input v-model="form.database" :class="fieldClass" spellcheck="false">
        </label>

        <div class="grid grid-cols-2 gap-2">
          <label class="grid gap-1">
            <span class="text-faint">User</span>
            <input v-model="form.username" :class="fieldClass" autocomplete="off" spellcheck="false">
          </label>
          <label class="grid gap-1">
            <span class="text-faint">Password</span>
            <input
              v-model="form.password"
              type="password"
              :class="fieldClass"
              autocomplete="new-password"
              :placeholder="editing && profile?.hasStoredPassword ? '•••••• (stored)' : ''"
            >
          </label>
        </div>

        <label class="flex items-center gap-2 text-muted">
          <input v-model="form.ssl" type="checkbox" class="accent-[var(--app-accent)]">
          Use SSL
        </label>

        <!-- Encrypt-only is the default and what a self-signed dev server
             needs; verification is opt-in, with the CA that signs the server
             when the system's roots do not know it. -->
        <div v-if="form.ssl" class="grid gap-2 rounded-md border border-edge p-2.5">
          <label class="flex items-start gap-2 text-muted">
            <input v-model="form.sslVerify" type="checkbox" class="mt-0.5 accent-[var(--app-accent)]">
            <span>
              Verify the server certificate
              <span class="block text-faint">Off, the connection is encrypted but the server is not checked.</span>
            </span>
          </label>

          <label v-for="slot in SSL_SLOTS" :key="slot.key" class="grid gap-1">
            <span class="text-faint">{{ slot.label }} <span class="opacity-70">: {{ slot.hint }}</span></span>
            <span class="flex gap-1">
              <input
                v-model="form[slot.key]"
                :class="fieldClass"
                class="min-w-0 flex-1 font-mono"
                placeholder="Path to a .pem file"
                spellcheck="false"
              >
              <button
                type="button"
                class="btn btn-ghost shrink-0"
                :disabled="!isAvailable"
                :title="`Pick the ${slot.label.toLowerCase()} file`"
                @click="browseCertificate(slot.key)"
              >
                <AppIcon name="folderOpen" :size="12" />
              </button>
            </span>
          </label>
        </div>
      </template>

      <!-- An explicit switch, like SSL: whether the tunnel is used is a fact
           about the profile and must never depend on which section happens
           to be open on screen. -->
      <label v-if="!isFileBased" class="flex items-center gap-2 text-muted">
        <input v-model="form.ssh!.enabled" type="checkbox" class="accent-[var(--app-accent)]">
        Connect through an SSH tunnel
      </label>

      <template v-if="!isFileBased && form.ssh?.enabled">
        <div class="grid gap-2 rounded-md border border-edge p-2.5">
          <p class="text-faint">
            The database host above is reached from the SSH host; the app talks to a local port it opens for the session.
          </p>

          <div class="grid grid-cols-[1fr_6rem] gap-2">
            <label class="grid gap-1">
              <span class="text-faint">SSH host</span>
              <input v-model="form.ssh!.host" :class="fieldClass" spellcheck="false" placeholder="bastion.example.com">
            </label>
            <label class="grid gap-1">
              <span class="text-faint">Port</span>
              <input v-model.number="form.ssh!.port" type="number" :class="fieldClass">
            </label>
          </div>

          <div class="grid grid-cols-2 gap-2">
            <label class="grid gap-1">
              <span class="text-faint">SSH user</span>
              <input v-model="form.ssh!.username" :class="fieldClass" autocomplete="off" spellcheck="false">
            </label>
            <label class="grid gap-1">
              <span class="text-faint">{{ form.ssh?.keyPath ? 'Key passphrase' : 'SSH password' }}</span>
              <input
                v-model="form.sshPassword"
                type="password"
                :class="fieldClass"
                autocomplete="new-password"
                :placeholder="editing && profile?.hasStoredSshSecret ? '•••••• (stored)' : ''"
              >
            </label>
          </div>

          <label class="grid gap-1">
            <span class="text-faint">Private key <span class="opacity-70">: leave empty to use the password</span></span>
            <span class="flex gap-1">
              <input v-model="form.ssh!.keyPath" :class="fieldClass" class="min-w-0 flex-1 font-mono" spellcheck="false" placeholder="~/.ssh/id_ed25519">
              <button type="button" class="btn btn-ghost shrink-0" :disabled="!isAvailable" title="Pick the key file" @click="browseKey">
                <AppIcon name="folderOpen" :size="12" />
              </button>
            </span>
          </label>
        </div>
      </template>

      </div>

      <!-- Right column: how the app treats the connection. -->
      <div class="grid content-start gap-3">
      <label class="grid gap-1">
        <span class="text-faint">Folder <span class="opacity-70">(optional: a heading to list it under)</span></span>
        <input
          v-model="form.folder"
          :class="fieldClass"
          :list="folderListId"
          placeholder="Production"
          maxlength="80"
          autocomplete="off"
        >
        <datalist :id="folderListId">
          <option v-for="folder in folders" :key="folder" :value="folder" />
        </datalist>
      </label>

      <div class="grid gap-1">
        <span id="connection-colour" class="text-faint">Colour</span>
        <span class="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-labelledby="connection-colour">
          <button
            type="button"
            role="radio"
            class="flex size-6 items-center justify-center rounded-md border border-edge text-faint hover:border-strong"
            :class="!form.color ? 'ring-2 ring-accent-line' : ''"
            :aria-checked="!form.color"
            title="No colour"
            @click="form.color = undefined"
          >
            <AppIcon name="close" :size="11" />
          </button>
          <button
            v-for="swatch in SWATCHES"
            :key="swatch.color"
            type="button"
            role="radio"
            class="size-6 rounded-md ring-offset-2 ring-offset-surface transition-shadow"
            :class="form.color === swatch.color ? 'ring-2 ring-content' : 'hover:ring-2 hover:ring-edge-strong'"
            :style="{ backgroundColor: swatch.color }"
            :aria-checked="form.color === swatch.color"
            :title="swatch.name"
            :aria-label="swatch.name"
            @click="form.color = swatch.color"
          />
        </span>
      </div>

      <label class="flex items-start gap-2 text-muted">
        <input v-model="form.readOnly" type="checkbox" class="mt-0.5 accent-[var(--app-accent)]">
        <span>
          Read-only
          <span class="block text-faint">Ask before any write goes through this connection — for production.</span>
        </span>
      </label>

      <label class="flex items-start gap-2 text-muted">
        <input v-model="form.noHistory" type="checkbox" class="mt-0.5 accent-[var(--app-accent)]">
        <span>
          Keep out of history
          <span class="block text-faint">Statements run here are not remembered — for ones that carry secrets.</span>
        </span>
      </label>

      </div>

      <p v-if="!isFileBased && !canStoreSecrets" class="flex items-start gap-2 text-warning sm:col-span-2">
        <AppIcon name="warning" />
        <span>
          This machine offers no OS keychain, so the password is kept for this session only.
        </span>
      </p>

      <p
        v-if="result"
        class="selectable flex items-start gap-2 sm:col-span-2"
        :class="result.ok ? 'text-success' : 'text-danger'"
      >
        <AppIcon :name="result.ok ? 'database' : 'warning'" />
        <span class="font-mono">{{ result.message }}</span>
      </p>

      </div>

      <footer class="flex shrink-0 items-center gap-2 border-t border-edge px-4 py-3">
        <button
          type="button"
          class="btn btn-outline px-3 py-1.5"
          :disabled="!complete || testing"
          @click="test"
        >
          {{ testing ? 'Testing…' : 'Test connection' }}
        </button>

        <span class="flex-1" />

        <button
          type="button"
          class="btn btn-ghost px-3 py-1.5"
          @click="close()"
        >
          Cancel
        </button>

        <button
          type="submit"
          class="btn btn-accent px-3 py-1.5"
          :disabled="!complete || saving"
        >
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </footer>
    </form>
  </AppDialog>
</template>
