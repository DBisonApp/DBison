<script setup lang="ts">
import { nodeId } from '#shared/db-nodes'
import type { DbNode, QueryContext, SchemaObject } from '#shared/db-types'
import type { Monaco } from '~/composables/useMonaco'

type CodeEditor = ReturnType<Monaco['editor']['create']>
type TextModel = ReturnType<Monaco['editor']['createModel']>

/**
 * Namespaces the markers this component owns, so setting them never disturbs
 * anything a language service might publish against the same model.
 */
const MARKER_OWNER = 'dbison-query'

/**
 * Distinguishes each tab's model. Two models may not share a URI, and the URI
 * has to be given explicitly: see `createModel` below.
 *
 * Random rather than a counter: Monaco's model registry outlives this module.
 * A hot reload in dev re-evaluates the module and would restart a counter at
 * zero while the editor still holds `query-0`, and `createModel` answers that
 * by throwing — which happens before the completion provider is wired up, so
 * one collision takes the whole tab's editor with it.
 */
function modelUri(monaco: Monaco) {
  return monaco.Uri.parse(`inmemory://dbison/query-${crypto.randomUUID()}.sql`)
}

/**
 * The piece of the buffer a run is about: either the selection, or the
 * statement the caret is in. Offsets are into the model's text.
 */
export interface SqlSlice {
  text: string
  start: number
  end: number
  source: 'selection' | 'statement' | 'all'
}

const props = withDefaults(
  defineProps<{
    placeholder?: string
    /** A fault to underline in the gutter and the text, from the last run. */
    problem?: SqlProblem | null
    /** Where the tab is pointed, which is what the completions are drawn from. */
    context?: QueryContext | null
    /** A viewer rather than an editor: the DDL of a table, for instance. */
    readOnly?: boolean
  }>(),
  { placeholder: '', problem: null, context: null, readOnly: false },
)

const sql = defineModel<string>({ required: true })

const { theme } = useAppTheme()
const connections = useConnections()
const completions = useSqlCompletions()
const { openTableData } = useWorkbench()

/**
 * The query context, plus the one thing the completions need that it does not
 * carry: how this engine quotes a name it hands back.
 */
const scope = computed<SqlEditorScope>(() => {
  const profile = connections.profiles.value.find((p) => p.id === props.context?.connectionId)

  return {
    connectionId: props.context?.connectionId ?? null,
    database: props.context?.database,
    schema: props.context?.schema,
    quote: profile ? connections.driverOf(profile).quote : '"',
  }
})

/** True once the tab could actually read its schema. */
const reachable = computed(
  () => Boolean(scope.value.connectionId)
    && connections.stateOf(scope.value.connectionId!).status === 'connected',
)

const host = useTemplateRef<HTMLElement>('host')
const ready = ref(false)

let monaco: Monaco | null = null
let editor: CodeEditor | null = null
let model: TextModel | null = null
let unregister: (() => void) | undefined

onMounted(async () => {
  const instance = await useMonaco()

  // The tab can be closed while the editor core is still loading.
  if (!host.value) return

  monaco = instance

  // Registered against the language, once for the whole app; each editor then
  // points its own model at the tab's context. See `useSqlCompletions`.
  completions.install(instance)

  // The URI is explicit on purpose. Left to itself modern-monaco names an
  // untitled model `file:///.inmemory/<random>.sql`, and its workspace layer
  // owns diagnostics for every file-scheme model: markers set on one are
  // cleared again before they can be drawn, so the squiggle never appears.
  const uri = modelUri(instance)

  // Belt and braces: whatever is left under this URI is not ours to keep, and
  // adding a second model under it would throw.
  instance.editor.getModel(uri)?.dispose()

  model = instance.editor.createModel(sql.value, 'sql', uri)

  // Through `setTheme` rather than the constructor option: modern-monaco wraps
  // it to keep Shiki's colour map in step with the active theme.
  instance.editor.setTheme(MONACO_THEMES[theme.value])

  editor = instance.editor.create(host.value, {
    model,
    placeholder: props.placeholder,
    fontFamily: '"JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace',
    fontSize: 13,
    lineHeight: 20,
    // dockview resizes panels without a window resize event to hook onto.
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    renderLineHighlight: 'line',
    roundedSelection: false,
    tabSize: 2,
    wordWrap: 'on',
    padding: { top: 8, bottom: 8 },
    scrollbar: { useShadows: false },
    // Panels clip their overflow, which would cut off the suggestion list.
    fixedOverflowWidgets: true,
    // The schema is a better source of names than the buffer is, and the two
    // together would offer every table twice.
    wordBasedSuggestions: 'off',
    quickSuggestions: { other: true, comments: false, strings: false },
    suggest: {
      showWords: false,
      // Ranks what was picked recently in this position first, which for a
      // column list is very often right.
      localityBonus: true,
      shareSuggestSelections: true,
    },
    suggestSelection: 'first',
    tabCompletion: 'on',
    readOnly: props.readOnly,
    domReadOnly: props.readOnly,
    // Explicit, because the explorer relies on it: a table name dragged off
    // the sidebar lands in the text as a plain-text drop, which Monaco only
    // accepts with this on.
    dragAndDrop: true,
  })

  unregister = completions.registerModel(model.uri.toString(), () => scope.value)

  installGoToTable(instance, editor)

  // F1 is the app's Keyboard Shortcuts, as in most desktop software. Monaco
  // claims it for its own command palette and swallows the keydown, so the
  // binding is dropped and the key bubbles up to the window like anywhere else.
  instance.editor.addKeybindingRule({ keybinding: instance.KeyCode.F1, command: '-editor.action.quickCommand' })

  editor.onDidChangeModelContent(() => {
    sql.value = model!.getValue()
  })

  // A failure may already have arrived while the core was still loading.
  applyProblem()

  ready.value = true
})

/**
 * The explorer node for an object the schema index resolved, addressed the
 * way the explorer would address it so an already-open tab is found rather
 * than duplicated.
 */
function nodeFor(object: SchemaObject): DbNode | null {
  const connectionId = scope.value.connectionId
  if (!connectionId) return null

  return {
    id: nodeId(connectionId, object.kind, object.path),
    connectionId,
    kind: object.kind,
    name: object.name,
    expandable: true,
    path: object.path,
  }
}

/** Opens the table or view named at an offset, and reports whether there was one. */
function goToTable(offset: number): boolean {
  if (!model) return false

  const object = completions.objectAt(model, offset)
  const node = object && nodeFor(object)
  if (!node) return false

  openTableData(node)
  return true
}

/**
 * Ctrl+click (Command on a Mac) and F12 on a table name open its data, the
 * way the same gestures open a definition in an IDE. A table name under the
 * pointer with the modifier down is underlined and given the hand cursor, so
 * the gesture is discoverable rather than a secret.
 */
function installGoToTable(instance: Monaco, target: CodeEditor) {
  const link = target.createDecorationsCollection()

  const chordHeld = (event: { ctrlKey: boolean, metaKey: boolean }) => event.ctrlKey || event.metaKey

  target.addAction({
    id: 'dbison.goToTable',
    label: 'Go to Table',
    keybindings: [instance.KeyCode.F12],
    contextMenuGroupId: 'navigation',
    run: (current) => {
      const position = current.getPosition()
      if (position && model) goToTable(model.getOffsetAt(position))
    },
  })

  target.onMouseDown((event) => {
    if (!event.event.leftButton || !chordHeld(event.event)) return
    if (event.target.type !== instance.editor.MouseTargetType.CONTENT_TEXT || !model) return

    if (goToTable(model.getOffsetAt(event.target.position))) event.event.preventDefault()
  })

  target.onMouseMove((event) => {
    const position = event.target.type === instance.editor.MouseTargetType.CONTENT_TEXT
      ? event.target.position
      : null
    const word = position && chordHeld(event.event) && model && completions.objectAt(model, model.getOffsetAt(position))
      ? model.getWordAtPosition(position)
      : null

    link.set(word && position
      ? [{
          range: {
            startLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endLineNumber: position.lineNumber,
            endColumn: word.endColumn,
          },
          options: { inlineClassName: 'sql-go-to-table' },
        }]
      : [])
  })

  // Releasing the modifier while the pointer rests on a name would otherwise
  // leave it underlined until the pointer moved again.
  target.onKeyUp(() => link.clear())
}

/**
 * Puts the engine's complaint on the offending token itself: a red squiggle,
 * a mark in the gutter, and the message on hover. This is the only place the
 * error reaches without the user first reading the panel below.
 */
function applyProblem() {
  if (!monaco || !model) return

  const problem = props.problem

  monaco.editor.setModelMarkers(model, MARKER_OWNER, problem
    ? [{
        severity: monaco.MarkerSeverity.Error,
        message: problem.message,
        startLineNumber: problem.line,
        startColumn: problem.column,
        // Engines point at a single token, which never spans a line break.
        endLineNumber: problem.line,
        endColumn: problem.column + problem.length,
      }]
    : [])
}

watch(() => props.problem, (problem) => {
  applyProblem()

  // Scrolled to, but not focused: the user may still be reading the message,
  // and a caret that jumps out from under the keyboard is its own annoyance.
  if (problem) {
    editor?.revealPositionInCenterIfOutsideViewport({
      lineNumber: problem.line,
      column: problem.column,
    })
  }
})

// Edits made elsewhere (a snippet dropped in from the navigator, say) still
// have to land in the editor, without echoing the user's own keystrokes back.
watch(sql, (next) => {
  if (model && next !== model.getValue()) model.setValue(next)
})

watch(theme, (next) => monaco?.editor.setTheme(MONACO_THEMES[next]))

// Read ahead of the first keystroke, so the first list is drawn from memory
// rather than from a round trip the user is waiting on.
watch(
  [() => scope.value.connectionId, () => scope.value.database, reachable],
  () => { if (reachable.value) completions.prefetch(scope.value) },
  { immediate: true },
)

onBeforeUnmount(() => {
  unregister?.()
  editor?.dispose()
  model?.dispose()
  editor = model = monaco = null
})

/**
 * Which statement to run for Ctrl+Enter, decided the way every SQL client
 * decides it: a selection is exactly what the user meant; failing that, the
 * statement under the caret. Comments and the closing semicolon are left out
 * of the text so a single statement reaches engines that only take one.
 */
function sliceToRun(): SqlSlice | null {
  if (!editor || !model) return null

  const selection = editor.getSelection()
  if (selection && !selection.isEmpty()) {
    const text = model.getValueInRange(selection)
    if (text.trim()) {
      return {
        text,
        start: model.getOffsetAt(selection.getStartPosition()),
        end: model.getOffsetAt(selection.getEndPosition()),
        source: 'selection',
      }
    }
  }

  const full = model.getValue()
  const tokens = tokenize(full)
  const position = editor.getPosition()
  const offset = position ? model.getOffsetAt(position) : full.length

  let [from, to] = statementRange(tokens, offset)
  let body = tokens.slice(from, to).filter((token) => token.kind !== 'comment')

  // A caret resting after the last semicolon, or on a blank line between two
  // statements, is in no statement at all; the one just above it is the one
  // the user is looking at.
  while (!body.length && from > 0) {
    ;[from, to] = statementRange(tokens, tokens[from - 1]!.start)
    body = tokens.slice(from, to).filter((token) => token.kind !== 'comment')
  }

  if (!body.length) return null

  const start = body[0]!.start
  const end = body.at(-1)!.end

  return { text: full.slice(start, end), start, end, source: 'statement' }
}

/** Decorations marking the statement the last run was about. */
let ranDecorations: ReturnType<CodeEditor['createDecorationsCollection']> | null = null

/**
 * Marks which statement ran. Only "statement" runs get one: a selection is
 * already highlighted by being a selection, and a whole-script run is the
 * whole buffer. The mark clears itself on the next edit, like the problem
 * marker does, and for the same reason.
 */
function markRan(slice: SqlSlice | null) {
  if (!editor || !model) return

  ranDecorations ??= editor.createDecorationsCollection()

  if (!slice || slice.source !== 'statement') {
    ranDecorations.clear()
    return
  }

  const startPosition = model.getPositionAt(slice.start)
  const endPosition = model.getPositionAt(slice.end)

  ranDecorations.set([{
    range: {
      startLineNumber: startPosition.lineNumber,
      startColumn: 1,
      endLineNumber: endPosition.lineNumber,
      endColumn: 1,
    },
    options: {
      isWholeLine: true,
      linesDecorationsClassName: 'sql-ran-line',
    },
  }])
}

/**
 * Replaces a region through the editor rather than through the model, so the
 * change is one undo step and the caret stays where it was.
 */
function replaceRange(start: number, end: number, text: string) {
  if (!editor || !model) return

  const range = {
    startLineNumber: model.getPositionAt(start).lineNumber,
    startColumn: model.getPositionAt(start).column,
    endLineNumber: model.getPositionAt(end).lineNumber,
    endColumn: model.getPositionAt(end).column,
  }

  editor.executeEdits('dbison-format', [{ range, text }])
  editor.pushUndoStop()
}

defineExpose({
  focus: () => editor?.focus(),
  sliceToRun,
  markRan,
  replaceRange,

  /** Whether the selection is non-empty, for the toolbar's wording. */
  hasSelection: () => {
    const selection = editor?.getSelection()
    return Boolean(selection && !selection.isEmpty())
  },

  /** Appends text as a new statement, leaving the caret at its end. */
  append: (text: string) => {
    if (!editor || !model) return

    const current = model.getValue()
    const separator = current.trim() ? (current.endsWith('\n') ? '\n' : '\n\n') : ''
    const insertAt = model.getPositionAt(current.length)

    editor.executeEdits('dbison-append', [{
      range: {
        startLineNumber: insertAt.lineNumber,
        startColumn: insertAt.column,
        endLineNumber: insertAt.lineNumber,
        endColumn: insertAt.column,
      },
      text: separator + text,
    }])
    editor.pushUndoStop()

    const end = model.getPositionAt(model.getValue().length)
    editor.setPosition(end)
    editor.revealPositionInCenterIfOutsideViewport(end)
    editor.focus()
  },

  /** Drops the caret on the reported fault, ready to fix it. */
  revealProblem: () => {
    if (!editor || !props.problem) return

    const position = { lineNumber: props.problem.line, column: props.problem.column }

    editor.setPosition(position)
    editor.revealPositionInCenterIfOutsideViewport(position)
    editor.focus()
  },
})
</script>

<template>
  <div class="relative">
    <div ref="host" class="absolute inset-0" />

    <p v-if="!ready" class="absolute inset-0 p-3 font-mono text-faint">
      Loading editor…
    </p>
  </div>
</template>

<style>
/* Unscoped: Monaco renders the decorated span itself, outside this component's
   scope hash. The name is namespaced so nothing else can collide with it. */
.sql-go-to-table {
  cursor: pointer;
  text-decoration: underline;
}
</style>
