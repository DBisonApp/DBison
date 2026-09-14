<script setup lang="ts">
import { useModalContext } from '@kolirt/vue-modal'
import type { CellValue } from '#shared/db-types'

/**
 * One cell, at the size it actually is.
 *
 * The grid shows a single line per row, which is right for scanning and useless
 * for the values that carry the interesting part — a JSON document, a stack
 * trace, a description, an image. This is where those are read.
 */
const props = defineProps<{
  column: string
  type: string
  value: CellValue
  /** When set, the value can be rewritten here and handed back to the grid. */
  editable?: boolean
  /**
   * The whole value of a binary cell, as base64. The grid only ever holds a
   * digest of one, which is enough to tell two blobs apart and no use for
   * looking at either; a caller that fetched the bytes hands them in here.
   */
  bytes?: string
  /** What the column or the caller says the bytes are, when it says anything. */
  mimeHint?: string
}>()

defineOptions({ modalGroup: 'dialog' })

/** Resolves with the new value; a dismissal resolves with nothing at all, so a
 *  staged NULL stays distinguishable from "never mind". */
const { confirm, close } = useModalContext<{ value: CellValue }>()

const text = computed(() => {
  if (props.value === null || props.value === undefined) return ''
  if (typeof props.value === 'boolean') return props.value ? 'true' : 'false'
  return String(props.value)
})

/**
 * JSON is stored as text, and reads as a wall of it. When the value parses as
 * an object or an array it is offered indented — never for a bare number or a
 * quoted string, where "formatting" would only strip the quotes and confuse a
 * text column for a JSON one.
 */
const formatted = computed(() => {
  const raw = text.value.trim()
  if (!raw.startsWith('{') && !raw.startsWith('[')) return null

  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  }
  catch {
    return null
  }
})

/* ---------------------------------------------------------------- bytes -- */

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)(?:[?#].*)?$/i

/** The image types the viewer can name from the first bytes alone. */
const SIGNATURES: { mime: string, magic: number[], at?: number }[] = [
  { mime: 'image/png', magic: [0x89, 0x50, 0x4E, 0x47] },
  { mime: 'image/jpeg', magic: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/bmp', magic: [0x42, 0x4D] },
  // RIFF....WEBP: the size in between is the file's own, so only the ends count.
  { mime: 'image/webp', magic: [0x57, 0x45, 0x42, 0x50], at: 8 },
]

/** The bytes decoded once, for the sniff and the hex dump both. */
const decoded = computed(() => {
  if (!props.bytes) return null

  try {
    const binary = atob(props.bytes)
    const out = new Uint8Array(binary.length)
    for (let at = 0; at < binary.length; at++) out[at] = binary.charCodeAt(at)
    return out
  }
  catch {
    return null
  }
})

/**
 * What the bytes are, by looking rather than by asking: a `bytea` column has
 * no type of its own, and a hint from the caller is trusted only when it
 * claims an image, since a wrong one would render as a broken picture.
 */
const sniffedMime = computed(() => {
  const data = decoded.value
  if (!data) return null

  const isRiff = data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46

  for (const { mime, magic, at = 0 } of SIGNATURES) {
    if (at > 0 && !isRiff) continue
    if (magic.every((byte, index) => data[at + index] === byte)) return mime
  }

  return props.mimeHint?.toLowerCase().startsWith('image/') ? props.mimeHint : null
})

/**
 * Something an <img> can load, when the cell holds one: a data URL, a link to
 * a picture, or bytes that turned out to be one.
 */
const imageSource = computed(() => {
  if (props.bytes) return sniffedMime.value ? `data:${sniffedMime.value};base64,${props.bytes}` : null

  const raw = text.value.trim()
  if (/^data:image\//i.test(raw)) return raw
  if (/^https?:\/\//i.test(raw) && IMAGE_EXTENSION.test(raw)) return raw

  return null
})

/** How much of a blob the hex dump shows; past this it is a file to save. */
const HEX_CAP = 4096

/**
 * The classic dump: an offset, sixteen bytes as hex, and the same sixteen as
 * text with the unprintable ones dotted out — the shape every hex tool uses,
 * so a header or a magic number is found where the eye expects it.
 */
const hexDump = computed(() => {
  const data = decoded.value
  if (!data) return ''

  const lines: string[] = []
  const shown = Math.min(data.length, HEX_CAP)

  for (let offset = 0; offset < shown; offset += 16) {
    const chunk = data.subarray(offset, Math.min(offset + 16, shown))
    const hex = [...chunk].map((byte) => byte.toString(16).padStart(2, '0'))
    const ascii = [...chunk].map((byte) => (byte >= 0x20 && byte <= 0x7E ? String.fromCharCode(byte) : '.'))

    // A gap after the eighth byte, so a 16-byte line can be read as two halves.
    const columns = `${hex.slice(0, 8).join(' ')}  ${hex.slice(8).join(' ')}`.padEnd(49)
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${columns}  ${ascii.join('')}`)
  }

  return lines.join('\n')
})

const hexTruncated = computed(() => (decoded.value?.length ?? 0) > HEX_CAP)

/** The picture's own size, read once it has loaded. */
const imageSize = ref<{ width: number, height: number } | null>(null)

function onImageLoad(event: Event) {
  const image = event.target as HTMLImageElement
  imageSize.value = { width: image.naturalWidth, height: image.naturalHeight }
}

/* ---------------------------------------------------------------- views -- */

/**
 * How the value is being looked at. Bytes open on what they are — the picture,
 * or the dump — since their text is only a digest.
 */
const view = ref<'text' | 'tree' | 'image' | 'hex'>(
  props.bytes ? (imageSource.value ? 'image' : 'hex') : 'text',
)

const pretty = ref(true)
const body = computed(() => (pretty.value && formatted.value ? formatted.value : text.value))

/** What is being typed, when the dialog is an editor rather than a viewer. */
const draft = ref(body.value)

/**
 * The document the tree paints: the draft's, when there is one, so the tree
 * shows what will be saved rather than what was loaded. Half-typed JSON has
 * no tree, and the toggle goes away until it parses again.
 */
const parsed = computed<unknown>(() => {
  const raw = (props.editable ? draft.value : text.value).trim()
  if (!raw.startsWith('{') && !raw.startsWith('[')) return undefined

  try {
    return JSON.parse(raw)
  }
  catch {
    return undefined
  }
})

const hasTree = computed(() => parsed.value !== undefined)

/**
 * Indenting an editable value rewrites what will be saved, not only what is on
 * screen: the two must not disagree about what the user is looking at.
 */
function toggleFormat() {
  pretty.value = !pretty.value
  if (!props.editable) return

  try {
    const value = JSON.parse(draft.value)
    draft.value = pretty.value ? JSON.stringify(value, null, 2) : JSON.stringify(value)
  }
  catch {
    // Half-typed JSON cannot be reformatted, and losing it would be worse than
    // leaving the button looking inert for a moment.
  }
}

/**
 * Whether the draft still parses, for a column that expects JSON.
 *
 * A warning rather than a block: the column may hold text that only looks like
 * JSON, and the engine is the one entitled to refuse it.
 */
const jsonError = computed(() => {
  if (!props.editable || !props.type.toLowerCase().startsWith('json')) return null
  if (!draft.value.trim()) return null

  try {
    JSON.parse(draft.value)
    return null
  }
  catch (error) {
    return error instanceof Error ? error.message : 'Not valid JSON'
  }
})

const copied = ref(false)

async function copy() {
  try {
    await navigator.clipboard.writeText(props.editable ? draft.value : body.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1600)
  }
  catch {
    copied.value = false
  }
}

const stats = computed(() => {
  if (decoded.value) {
    const size = decoded.value.length
    return `${size.toLocaleString()} byte${size === 1 ? '' : 's'}${sniffedMime.value ? ` · ${sniffedMime.value}` : ''}`
  }

  const shown = props.editable ? draft.value : text.value
  const lines = shown ? shown.split('\n').length : 0
  const characters = shown.length

  return [
    `${characters} character${characters === 1 ? '' : 's'}`,
    lines > 1 ? `${lines} lines` : null,
  ].filter(Boolean).join(' · ')
})
</script>

<template>
  <AppDialog :title="column" size="lg">
    <div class="flex min-h-0 flex-col gap-2 p-3">
      <div class="flex items-center gap-2">
        <span class="chip font-mono font-normal text-faint">{{ type }}</span>
        <span class="text-faint">{{ stats }}</span>

        <span class="ml-auto flex items-center gap-1">
          <!-- The picture, or the dump, against the text it came from. -->
          <template v-if="imageSource || bytes">
            <button
              v-if="view === 'image' || view === 'hex'"
              type="button"
              class="btn btn-ghost"
              :title="bytes ? 'Show the digest the grid holds' : 'Show the text of the value'"
              @click="view = 'text'"
            >
              Text
            </button>

            <button
              v-else
              type="button"
              class="btn btn-ghost"
              :title="imageSource ? 'Show it as a picture' : 'Show the bytes as a hex dump'"
              @click="view = imageSource ? 'image' : 'hex'"
            >
              {{ imageSource ? 'Image' : 'Hex' }}
            </button>
          </template>

          <button
            v-if="hasTree && (view === 'text' || view === 'tree')"
            type="button"
            class="btn btn-ghost"
            :title="view === 'tree' ? 'Show it as text' : 'Show it as a tree that folds'"
            @click="view = view === 'tree' ? 'text' : 'tree'"
          >
            {{ view === 'tree' ? 'Text' : 'Tree' }}
          </button>

          <button
            v-if="formatted && view === 'text'"
            type="button"
            class="btn btn-ghost"
            :title="pretty ? 'Show it exactly as stored' : 'Indent it as JSON'"
            @click="toggleFormat"
          >
            {{ pretty ? 'Raw' : 'Format JSON' }}
          </button>

          <button type="button" class="btn btn-ghost" @click="copy">
            <AppIcon name="copy" :size="12" />
            {{ copied ? 'Copied' : 'Copy' }}
          </button>
        </span>
      </div>

      <div
        v-if="view === 'image' && imageSource"
        class="flex flex-col items-center gap-1 rounded-md border border-edge bg-bg px-3 py-2"
      >
        <img
          :src="imageSource"
          :alt="column"
          class="max-h-[60vh] max-w-full object-contain"
          @load="onImageLoad"
        >
        <span v-if="imageSize" class="text-faint tabular-nums">
          {{ imageSize.width }} × {{ imageSize.height }}
        </span>
      </div>

      <div v-else-if="view === 'hex'" class="flex min-h-0 flex-col gap-1">
        <pre
          class="selectable max-h-[60vh] min-h-24 overflow-auto rounded-md border border-edge bg-bg px-3 py-2 font-mono text-[12px] text-content"
        >{{ hexDump || 'Could not decode these bytes.' }}</pre>
        <p v-if="hexTruncated" class="text-faint">
          Only the first {{ HEX_CAP.toLocaleString() }} bytes are shown.
        </p>
      </div>

      <div
        v-else-if="view === 'tree' && hasTree"
        class="max-h-[60vh] min-h-24 overflow-auto rounded-md border border-edge bg-bg px-3 py-2"
      >
        <JsonTree :value="parsed" />
      </div>

      <textarea
        v-else-if="editable"
        v-model="draft"
        spellcheck="false"
        class="selectable field max-h-[60vh] min-h-48 w-full resize-y overflow-auto font-mono text-[12px] leading-relaxed"
        :placeholder="value === null ? 'NULL' : ''"
      />

      <p v-else-if="value === null" class="rounded-md border border-edge bg-bg px-3 py-2">
        <span class="null-pill">NULL</span>
      </p>

      <pre
        v-else
        class="selectable max-h-[60vh] min-h-24 overflow-auto rounded-md border border-edge bg-bg px-3 py-2 font-mono text-[12px] whitespace-pre-wrap text-content"
      >{{ body }}</pre>

      <p v-if="jsonError" class="flex items-start gap-1.5 text-warning">
        <AppIcon name="warning" :size="12" class="mt-0.5" />
        <span class="selectable">{{ jsonError }} — it will be stored exactly as typed.</span>
      </p>

      <footer class="flex items-center justify-end gap-2">
        <button
          v-if="editable"
          type="button"
          class="btn btn-ghost mr-auto px-3 py-1.5"
          title="Store nothing at all in this column"
          @click="confirm({ value: null })"
        >
          Set NULL
        </button>

        <button type="button" class="btn btn-ghost px-3 py-1.5" @click="close()">
          {{ editable ? 'Cancel' : 'Close' }}
        </button>

        <button
          v-if="editable"
          type="button"
          class="btn btn-accent px-3 py-1.5"
          autofocus
          @click="confirm({ value: draft })"
        >
          Stage change
        </button>
      </footer>
    </div>
  </AppDialog>
</template>

<style scoped>
.null-pill {
  display: inline-block;
  border-radius: 3px;
  background-color: color-mix(in oklab, var(--app-type-null) 22%, transparent);
  padding-inline: 0.3rem;
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--app-type-null);
}
</style>
