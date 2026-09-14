<script setup lang="ts">
import type { ConnectionProfile } from '#shared/db-types'

/**
 * Which server the explorer is pointed at.
 *
 * Every connection used to be a root of the tree, so opening a second one
 * pushed the first one's tables down the panel and cost a level of indentation
 * for something the user was not looking at. Only one is current here, and the
 * rest are one keystroke away: type to narrow, arrows to move, Enter to switch.
 */

const explorer = useExplorer()
const connections = useConnections()
const { openConnectionDialog, confirm, openBackup, prompt } = useDialogs()

const open = ref(false)
const query = ref('')

/** Below this many, the list is quicker to read than to filter. */
const SEARCHABLE_FROM = 5

const DOT_CLASS: Record<string, string> = {
  connected: 'bg-success',
  connecting: 'bg-warning app-pulse',
  disconnected: 'bg-faint',
  error: 'bg-danger',
}

const STATUS_LABEL: Record<string, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Not connected',
  error: 'Failed to connect',
}

const matches = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return connections.profiles.value

  return connections.profiles.value.filter((profile) =>
    [profile.name, profile.folder, profile.host, profile.file, profile.database, profile.username]
      .some((field) => field?.toLowerCase().includes(needle)),
  )
})

/**
 * The matches under their folders: the ones without a folder first and under
 * no heading, then one group per folder, alphabetically. Folderless first
 * because a folder is something the user added on purpose, and the plain list
 * is what everyone starts with — a heading over it would be labelling the
 * absence of a label.
 */
const groups = computed(() => {
  const byFolder = new Map<string, ConnectionProfile[]>()

  for (const profile of matches.value) {
    const folder = profile.folder?.trim() ?? ''
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), profile])
  }

  const loose = byFolder.get('') ?? []
  byFolder.delete('')

  return [
    { folder: '', profiles: loose },
    ...[...byFolder.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([folder, profiles]) => ({ folder, profiles })),
  ].filter((group) => group.profiles.length)
})

/**
 * Where a profile lives, split so the row can truncate the long half.
 *
 * A managed host is named something like
 * `db-postgresql-fra1-51234-do-user-9876543-0.m.db.ondigitalocean.com`, which
 * is at once the least distinctive part of the line and the part that would
 * push everything after it out of the panel. It gets the elastic half; the
 * database — what actually differs between two rows on the same cluster — is
 * pinned and stays readable.
 */
function where(profile: ConnectionProfile) {
  const driver = connections.driverOf(profile)

  if (driver.target === 'file') {
    const file = profile.file ?? ''
    return { lead: file.split(/[/\\]/).pop() ?? file, tail: '' }
  }

  return {
    lead: [profile.host, profile.port].filter(Boolean).join(':'),
    tail: profile.database ?? '',
  }
}

/** The whole address, for the tooltip a truncated line cannot show. */
function fullWhere(profile: ConnectionProfile) {
  if (connections.driverOf(profile).target === 'file') return profile.file ?? ''

  const { lead, tail } = where(profile)
  return tail ? `${lead}/${tail}` : lead
}

async function pick(id: string) {
  const profile = connections.profiles.value.find((p) => p.id === id)
  if (!profile) return

  open.value = false
  explorer.select(profile.id)

  // Switching to a connection is the whole intent; making the user then click
  // "connect" would just be the old two-step in a new place.
  if (connections.stateOf(profile.id).status !== 'connected') {
    await connections.connect(profile.id)
  }
}

function edit(profile: ConnectionProfile) {
  open.value = false
  openConnectionDialog(profile)
}

/** The dialog prefilled from this profile; saving makes a second one. */
function duplicate(profile: ConnectionProfile) {
  open.value = false
  openConnectionDialog(profile, { duplicate: true })
}

/** Whether the engine has a dump tool the app knows how to drive. */
function canBackup(profile: ConnectionProfile) {
  return Boolean(connections.driverOf(profile).capabilities?.dump)
}

async function backup(profile: ConnectionProfile, mode: 'dump' | 'restore') {
  open.value = false

  const outcome = await openBackup({ profile, mode })

  // A restore replaced what the explorer is showing; the old snapshot would
  // list tables that no longer exist and miss the ones that now do.
  if (outcome?.ok && mode === 'restore' && explorer.connectionId.value === profile.id) explorer.refresh()
}

/**
 * A folder is only the word on its connections, so "renaming" and "removing"
 * one rewrite that word on each of them. Removing keeps the connections; it
 * is the heading that goes, not what is under it.
 */
async function renameFolder(folder: string) {
  open.value = false

  const next = await prompt({
    title: 'Rename folder',
    label: 'Folder name',
    value: folder,
    confirmLabel: 'Rename',
    hint: 'Every connection listed under it moves along.',
  })

  if (next && next !== folder) await connections.moveFolder(folder, next)
}

async function removeFolder(folder: string) {
  open.value = false

  const count = connections.profiles.value.filter((p) => (p.folder?.trim() ?? '') === folder).length
  const ok = await confirm({
    title: 'Remove folder',
    message: `The heading "${folder}" goes away; its ${count} connection${count === 1 ? '' : 's'} stay${count === 1 ? 's' : ''}, listed without a folder.`,
    confirmLabel: 'Remove folder',
  })

  if (ok) await connections.moveFolder(folder, undefined)
}

async function remove(profile: ConnectionProfile) {
  // The picker closes first: the confirmation is a modal over the top of it,
  // and answering that would dismiss the list underneath anyway.
  open.value = false

  const ok = await confirm({
    title: 'Remove connection',
    message: `"${profile.name}" will be removed, along with any password stored for it.`,
    confirmLabel: 'Remove',
    danger: true,
  })

  if (ok) await connections.remove(profile.id)
}

// Reka moves the highlight, keeps it on a list that shrinks under it, and hands
// focus to the search box on open — all of which this component used to do by
// hand. What is left is emptying the box, so a stale term never hides the list
// the next time it opens.
watch(open, (value) => {
  if (value) query.value = ''
})
</script>

<template>
  <Combobox v-model:open="open" @update:model-value="pick($event!)">
    <ComboboxTrigger>
      <button
        type="button"
        class="flex w-full items-center gap-2 px-2 py-2 text-left transition-colors hover:bg-surface data-[state=open]:bg-surface"
        :title="explorer.profile.value
          ? `${explorer.profile.value.name} — ${fullWhere(explorer.profile.value)}`
          : 'Choose a connection'"
      >
        <template v-if="explorer.profile.value">
          <DriverIcon :driver="explorer.profile.value.driver" :size="16" />

          <span class="min-w-0 flex-1 truncate font-medium">
            <!-- The folder rides along dimly: "Production / api-db" says at a
                 glance what "api-db" alone leaves to memory. -->
            <span v-if="explorer.profile.value.folder" class="font-normal text-faint">{{ explorer.profile.value.folder }} / </span>{{ explorer.profile.value.name }}
          </span>

          <ConnectionSwatch :profile="explorer.profile.value" lock />

          <span class="size-1.5 shrink-0 rounded-full" :class="DOT_CLASS[explorer.status.value]" />
        </template>

        <template v-else>
          <AppIcon name="database" class="text-faint" />
          <span class="min-w-0 flex-1 truncate text-faint">No connection</span>
        </template>

        <AppIcon name="chevronDown" :size="12" class="text-faint" />
      </button>
    </ComboboxTrigger>

    <!--
      The panel follows the explorer's width, but only within reason. Reka's
      popper wrapper is `min-width: max-content`, so with nothing holding it
      back one managed-host name stretches the list to twice the width of the
      panel it dropped out of, straight across the workspace behind it.
    -->
    <ComboboxContent
      class="w-[var(--reka-combobox-trigger-width)] min-w-60 max-w-[min(26rem,var(--reka-combobox-content-available-width))]"
    >
      <ComboboxInput
        v-if="connections.profiles.value.length > SEARCHABLE_FROM"
        v-model="query"
        placeholder="Find a connection"
      />

      <div class="min-h-0 flex-1 overflow-auto py-1">
        <ComboboxEmpty>
          {{ connections.profiles.value.length ? 'No match' : 'No connections yet.' }}
        </ComboboxEmpty>

        <!-- Headings are Reka labels, not items: the arrow keys step over
             them and Enter can never land on one. -->
        <ComboboxGroup v-for="group in groups" :key="group.folder">
          <ComboboxLabel v-if="group.folder" class="group/folder">
            <AppIcon name="folder" :size="11" />
            <span class="truncate">{{ group.folder }}</span>

            <!-- The folder's own menu, on the heading: rename it, or take
                 the heading away and leave its connections in the plain list. -->
            <DropdownMenu>
              <DropdownMenuTrigger>
                <button
                  type="button"
                  class="btn-icon ml-auto -my-1 opacity-0 transition-opacity group-hover/folder:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                  :aria-label="`Folder ${group.folder}: rename or remove`"
                  title="Rename or remove this folder"
                  @pointerdown.stop
                  @click.stop
                >
                  <AppIcon name="more" :size="12" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem icon="pencil" @select="renameFolder(group.folder)">
                  Rename folder…
                </DropdownMenuItem>
                <DropdownMenuItem icon="close" @select="removeFolder(group.folder)">
                  Remove folder
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </ComboboxLabel>

          <ComboboxItem
            v-for="profile in group.profiles"
            :key="profile.id"
            :value="profile.id"
            :data-active="profile.id === explorer.connectionId.value"
          >
            <DriverIcon :driver="profile.driver" :size="16" />
  
            <span class="min-w-0 flex-1" :title="fullWhere(profile)">
              <span class="flex items-center gap-1.5">
                <ConnectionSwatch :profile="profile" lock />
                <span class="truncate">{{ profile.name }}</span>
                <span
                  class="size-1.5 shrink-0 rounded-full"
                  :class="DOT_CLASS[connections.stateOf(profile.id).status]"
                  :title="STATUS_LABEL[connections.stateOf(profile.id).status]"
                />
              </span>
  
              <span class="flex text-faint">
                <span class="truncate">{{ where(profile).lead }}</span>
                <span v-if="where(profile).tail" class="shrink-0">&nbsp;·&nbsp;{{ where(profile).tail }}</span>
              </span>
            </span>
  
            <!-- One overflow menu rather than a row of icons that exist only on
                 hover: three 12px targets appearing under the pointer were easy
                 to hit by accident and hard to find on purpose. Both events are
                 stopped — a click would pick the row, and Reka commits a choice
                 on pointerdown before the click ever lands. -->
            <DropdownMenu>
              <DropdownMenuTrigger>
                <button
                  type="button"
                  class="btn-icon shrink-0 p-1.5 opacity-40 transition-opacity group-hover:opacity-100 group-data-[highlighted]:opacity-100 focus-visible:opacity-100 data-[state=open]:bg-surface-raised data-[state=open]:opacity-100"
                  :title="`Actions for ${profile.name}`"
                  :aria-label="`Actions for ${profile.name}`"
                  @pointerdown.stop
                  @click.stop
                >
                  <AppIcon name="more" :size="14" />
                </button>
              </DropdownMenuTrigger>
  
              <DropdownMenuContent @close-auto-focus.prevent>
                <DropdownMenuItem
                  v-if="connections.stateOf(profile.id).status === 'connected'"
                  icon="unplug"
                  @select="connections.disconnect(profile.id)"
                >
                  Disconnect
                </DropdownMenuItem>
  
                <DropdownMenuItem v-else icon="plug" @select="pick(profile.id)">
                  Connect
                </DropdownMenuItem>
  
                <DropdownMenuItem icon="pencil" @select="edit(profile)">
                  Edit connection…
                </DropdownMenuItem>

                <!-- Only where the engine has a tool to run; the dialog
                     itself says when that tool is not installed. -->
                <template v-if="canBackup(profile)">
                  <DropdownMenuItem icon="archive" @select="backup(profile, 'dump')">
                    Backup…
                  </DropdownMenuItem>

                  <DropdownMenuItem icon="archiveRestore" @select="backup(profile, 'restore')">
                    Restore…
                  </DropdownMenuItem>
                </template>

                <DropdownMenuItem icon="duplicate" @select="duplicate(profile)">
                  Duplicate…
                </DropdownMenuItem>
  
                <DropdownMenuSeparator />
  
                <DropdownMenuItem icon="trash" danger @select="remove(profile)">
                  Remove…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </ComboboxItem>
        </ComboboxGroup>
      </div>

      <button
        type="button"
        class="flex w-full shrink-0 items-center gap-2 border-t border-edge px-2.5 py-2 text-accent-bright transition-colors hover:bg-accent-soft"
        @click="open = false; openConnectionDialog()"
      >
        <AppIcon name="plus" :size="12" />
        New connection…
      </button>
    </ComboboxContent>
  </Combobox>
</template>
