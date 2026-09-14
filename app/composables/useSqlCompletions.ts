import type { SchemaObject } from '#shared/db-types'
import type { Monaco } from '~/composables/useMonaco'
import type { CompletionSeed, SchemaIndex, SeedKind } from '~/utils/schema-index'

/**
 * Schema-aware completion and hover for the query editor.
 *
 * One provider serves every tab. Monaco registers providers per language, not
 * per editor, so the alternative is one registration per open tab all answering
 * for each other's models — the same list, computed several times over. Each
 * tab instead leaves a callback here saying where it is pointed, and the
 * provider looks up the model it was asked about.
 *
 * The work per keystroke is one tokenize (memoized against the model version),
 * one backwards scan of the statement under the caret, and a concatenation of
 * lists the index built when the schema was read. Nothing here talks to the
 * database.
 */

type TextModel = ReturnType<Monaco['editor']['createModel']>

/** Where a tab's editor is pointed, read fresh on every request. */
export interface SqlEditorScope {
  connectionId: string | null
  database?: string
  schema?: string
  /** The engine's identifier quote, so completions insert names it accepts. */
  quote: string
}

interface EditorPosition {
  lineNumber: number
  column: number
}

/** Monaco's `CompletionContext`, as much of it as this provider reads. */
interface TriggerContext {
  triggerKind: number
  triggerCharacter?: string
}

/**
 * Positions where a space is enough on its own to know what comes next, and so
 * the ones where the list may open without anything having been typed.
 */
const OPENS_ON_SPACE = new Set<SqlClause>(['from', 'join', 'on'])

interface EditorRange {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

/** A Monaco completion item, plus the seed it came from for the resolve step. */
interface SeedItem {
  label: string
  kind: number
  insertText: string
  detail?: string
  filterText?: string
  sortText: string
  range: EditorRange
  insertTextRules?: number
  documentation?: { value: string }
  seed: CompletionSeed
}

/**
 * Past this the list is no longer worth ranking in full: it is filtered by what
 * has been typed and reported as incomplete, so Monaco asks again as the word
 * grows. Only a schema in the thousands of tables ever reaches it.
 */
const MAX_SUGGESTIONS = 2_000

/** Which icon each kind of suggestion draws with. */
const KIND: Record<SeedKind, keyof Monaco['languages']['CompletionItemKind']> = {
  column: 'Field',
  table: 'Struct',
  view: 'Interface',
  schema: 'Module',
  alias: 'Variable',
  join: 'Snippet',
  function: 'Function',
  keyword: 'Keyword',
}

/** Model URI to the query tab that owns it, and whether Monaco has us yet. */
interface Registry {
  scopes: Map<string, () => SqlEditorScope>
  installed: boolean
}

/**
 * Held on `globalThis`, not in module scope.
 *
 * Monaco's language registry outlives a hot reload of this module: a fresh copy
 * would register a second provider and, worse, start with an empty model map,
 * leaving every editor already on screen with no context and no completions.
 * Sharing the registry across reloads keeps both halves in step.
 */
const REGISTRY_KEY = '__dbisonSqlCompletions'

const registry: Registry = ((globalThis as unknown as Record<string, Registry | undefined>)[REGISTRY_KEY] ??= {
  scopes: new Map(),
  installed: false,
})

/** Tokens of a model, kept until its content changes. */
const tokenCache = new WeakMap<TextModel, { version: number, tokens: SqlToken[] }>()

function tokensOf(model: TextModel): SqlToken[] {
  const version = model.getVersionId()
  const cached = tokenCache.get(model)

  if (cached?.version === version) return cached.tokens

  const tokens = tokenize(model.getValue())
  tokenCache.set(model, { version, tokens })

  return tokens
}

/**
 * The table or view an identifier names, whether by its own name or through
 * an alias the statement gave it. The hover and "go to table" both start
 * here, so what the one describes is what the other opens.
 */
function resolveToken(
  index: SchemaIndex,
  tokens: SqlToken[],
  token: SqlToken,
  defaultSchema: string,
) {
  // Read at the end of the token, so the identifier counts as fully typed and
  // whatever qualified it is in front of the caret.
  const analysis = analyzeSql(tokens, token.end)
  const name = identifierOf(token)
  const scope = index.scope(analysis.tables, defaultSchema)

  const aliased = scope.find((table) => table.as.toLowerCase() === name.toLowerCase())
  const object = aliased?.object ?? index.resolve([...analysis.qualifier, name], defaultSchema)

  return { analysis, name, scope, object }
}

/**
 * What the identifier under the pointer is: a table, an alias for one, or a
 * column of a table the statement has in scope.
 */
function describeAt(
  index: SchemaIndex,
  tokens: SqlToken[],
  token: SqlToken,
  defaultSchema: string,
): string | null {
  const { analysis, name, scope, object } = resolveToken(index, tokens, token, defaultSchema)

  if (object) return documentObject(object)

  // A column is only meaningful against the tables this statement named, and
  // its own qualifier says which of them to look in.
  const qualifier = analysis.qualifier.at(-1)
  const searched = qualifier
    ? scope.filter((table) => table.as.toLowerCase() === qualifier.toLowerCase())
    : scope

  for (const table of searched) {
    const column = table.object.columns.find((c) => c.name.toLowerCase() === name.toLowerCase())
    if (!column) continue

    const flags = [column.primaryKey ? 'primary key' : '', column.nullable ? 'nullable' : 'not null']
      .filter(Boolean)
      .join(' · ')

    return `**${table.object.name}.${column.name}** · ${column.type}\n\n${flags}`
  }

  return null
}

export function useSqlCompletions() {
  const schemaIndex = useSchemaIndex()

  /**
   * Points one editor model at a query tab's context. The callback is read on
   * every request rather than copied, so re-pointing a tab at another database
   * changes what it completes without re-registering anything.
   */
  function registerModel(uri: string, scope: () => SqlEditorScope) {
    registry.scopes.set(uri, scope)
    return () => registry.scopes.delete(uri)
  }

  function scopeFor(model: TextModel): SqlEditorScope | null {
    return registry.scopes.get(model.uri.toString())?.() ?? null
  }

  /**
   * The table or view named at an offset of a registered model, for a
   * Ctrl+click or F12 on it. Null for anything else under the caret — a
   * column, a keyword, a name the schema does not know — and while the schema
   * is still being read.
   */
  function objectAt(model: TextModel, offset: number): SchemaObject | null {
    const scope = scopeFor(model)
    if (!scope) return null

    const tokens = tokensOf(model)
    const token = tokenAt(tokens, offset)
    if (token?.kind !== 'word' && token?.kind !== 'quoted') return null

    const { index } = schemaIndex.indexFor(scope)
    if (!index) return null

    return resolveToken(index, tokens, token, scope.schema ?? '').object
  }

  function install(monaco: Monaco) {
    if (registry.installed) return
    registry.installed = true

    const kinds = monaco.languages.CompletionItemKind
    const asSnippet = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet

    const completions = {
      // A dot always changes what should be offered. A space only does where
      // the clause already says what belongs next — see the guard below, which
      // is what keeps this from popping a list open after every word typed.
      triggerCharacters: ['.', ' '],

      provideCompletionItems(model: TextModel, position: EditorPosition, context: TriggerContext) {
        const scope = scopeFor(model)
        if (!scope) return { suggestions: [] }

        const tokens = tokensOf(model)
        const offset = model.getOffsetAt(position)

        // Inside a string or a comment, nothing is an identifier.
        const here = tokenAt(tokens, offset)
        if (here?.kind === 'string' || here?.kind === 'comment') return { suggestions: [] }

        const analysis = analyzeSql(tokens, offset)

        // `from |` and `join |` open the table list unprompted, because there
        // the editor knows the answer before the user has typed a letter of it.
        // Anywhere else a space is just a space.
        if (
          context.triggerCharacter === ' '
          && !OPENS_ON_SPACE.has(analysis.clause)
          && !analysis.atAlias
        ) {
          return { suggestions: [] }
        }

        const { index, loading } = schemaIndex.indexFor(scope)

        // Until the schema lands there is still a language to complete in.
        const seeds = index
          ? seedsAt(analysis, index, scope.schema ?? '')
          : [...vocabulary().statement, ...vocabulary().clause, ...vocabulary().functions]

        const range: EditorRange = {
          startLineNumber: position.lineNumber,
          startColumn: position.column - (offset - analysis.wordStart),
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        }

        const word = analysis.word.toLowerCase()
        let shown = seeds
        let incomplete = loading

        if (seeds.length > MAX_SUGGESTIONS) {
          // Monaco ranks the whole list itself, which past this size is the
          // expensive part; the obvious non-matches are dropped here instead
          // and the list is reported incomplete so it is asked for again.
          shown = (word
            ? seeds.filter((seed) => (seed.filterText ?? seed.label).toLowerCase().includes(word))
            : seeds
          ).slice(0, MAX_SUGGESTIONS)

          incomplete = true
        }

        return {
          incomplete,
          suggestions: shown.map((seed) => ({
            label: seed.label,
            kind: kinds[KIND[seed.kind]],
            insertText: seed.insertText,
            detail: seed.detail,
            filterText: seed.filterText,
            sortText: seed.sortText,
            insertTextRules: seed.snippet ? asSnippet : undefined,
            range,
            seed,
          } satisfies SeedItem)),
        }
      },

      /**
       * The column list behind a table suggestion is built here rather than up
       * front: it runs for the one item the user has highlighted, not for the
       * three thousand they scrolled past.
       */
      resolveCompletionItem(item: SeedItem) {
        const documentation = item.seed?.documentation?.()
        return documentation ? { ...item, documentation: { value: documentation } } : item
      },
    }

    monaco.languages.registerCompletionItemProvider(
      'sql',
      completions as unknown as Parameters<Monaco['languages']['registerCompletionItemProvider']>[1],
    )

    const hovers = {
      provideHover(model: TextModel, position: EditorPosition) {
        const scope = scopeFor(model)
        if (!scope) return null

        const tokens = tokensOf(model)
        const offset = model.getOffsetAt(position)
        const token = tokenAt(tokens, offset)

        if (token?.kind !== 'word' && token?.kind !== 'quoted') return null

        const { index } = schemaIndex.indexFor(scope)
        if (!index) return null

        const value = describeAt(index, tokens, token, scope.schema ?? '')
        if (!value) return null

        return {
          range: {
            startLineNumber: position.lineNumber,
            startColumn: position.column - (offset - token.start),
            endLineNumber: position.lineNumber,
            endColumn: position.column + (token.end - offset),
          },
          contents: [{ value }],
        }
      },
    }

    monaco.languages.registerHoverProvider(
      'sql',
      hovers as unknown as Parameters<Monaco['languages']['registerHoverProvider']>[1],
    )
  }

  return {
    install,
    registerModel,
    objectAt,
    prefetch: schemaIndex.prefetch,
    statusFor: schemaIndex.statusFor,
    forget: schemaIndex.forget,
    reload: schemaIndex.reload,
  }
}
