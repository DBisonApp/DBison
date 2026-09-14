import type { init, TextmateTheme } from 'modern-monaco'

import type { AppThemeName } from './useAppTheme'

export type Monaco = Awaited<ReturnType<typeof init>>

/** Theme ids registered below, one per `AppThemeName`. */
export const MONACO_THEMES: Record<AppThemeName, string> = {
  dark: 'dbison-dark',
  light: 'dbison-light',
}

/**
 * The editor core is a few megabytes and every query tab wants the same one,
 * so the boot runs once and every caller awaits the same promise.
 */
let booting: Promise<Monaco> | null = null

/**
 * Loads Monaco on first use. The whole of modern-monaco — Shiki, its wasm
 * regex engine, the grammar — is imported dynamically so it stays out of the
 * chunk that paints the workbench.
 */
export function useMonaco(): Promise<Monaco> {
  booting ??= boot()
  return booting
}

async function boot(): Promise<Monaco> {
  // `modern-monaco/core` drops the bundled HTML/CSS/JSON/TypeScript language
  // servers; SQL has no LSP here, so all we need from it is the tokenizer.
  const [{ init }, sql, dark, light] = await Promise.all([
    import('modern-monaco/core'),
    import('tm-grammars/grammars/sql.json'),
    import('tm-themes/themes/github-dark-default.json'),
    import('tm-themes/themes/github-light-default.json'),
  ])

  // Both themes go in as objects: a `defaultTheme` name is looked up against
  // Shiki's own theme list (and fetched from the CDN), so it cannot name one of
  // ours. The first entry is the one the editor starts on.
  return init({
    langs: [sql.default],
    themes: [appTheme(dark.default, 'dark'), appTheme(light.default, 'light')],
  })
}

/**
 * GitHub's themes already match the app's token colours; only the chrome around
 * the code has to be pulled onto our own surfaces so the editor does not read
 * as a panel pasted into the window.
 */
function appTheme(base: unknown, name: AppThemeName): TextmateTheme {
  const theme = base as TextmateTheme

  const chrome = name === 'dark'
    ? {
        'editor.background': '#10192c',
        'editor.lineHighlightBackground': '#ffffff08',
        'editorLineNumber.foreground': '#696c7e',
        'editorLineNumber.activeForeground': '#9497a9',
        'editorWidget.background': '#1c1c2a',
        'editorWidget.border': '#3d3d63',
        'editorSuggestWidget.background': '#1c1c2a',
        'editorSuggestWidget.border': '#3d3d63',
        'editorSuggestWidget.selectedBackground': '#2b2b4a',
      }
    : {
        'editor.background': '#ffffff',
        'editor.lineHighlightBackground': '#00000006',
        'editorLineNumber.foreground': '#8c959f',
        'editorLineNumber.activeForeground': '#57606a',
        'editorWidget.background': '#f6f8fa',
        'editorWidget.border': '#d0d7de',
        'editorSuggestWidget.background': '#f6f8fa',
        'editorSuggestWidget.border': '#d0d7de',
        'editorSuggestWidget.selectedBackground': '#eaeef2',
      }

  return {
    ...theme,
    name: MONACO_THEMES[name],
    colors: { ...theme.colors, ...chrome },
  }
}
