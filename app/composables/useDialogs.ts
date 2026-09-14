import { openModal } from '@kolirt/vue-modal'
import type { CellValue, ConnectionProfile, ExportOutcome, SavedQuery, ToolOutcome } from '#shared/db-types'
import AboutDialog from '~/components/ui/AboutDialog.vue'
import CellValueDialog from '~/components/ui/CellValueDialog.vue'
import ConfirmDialog from '~/components/ui/ConfirmDialog.vue'
import ParametersDialog from '~/components/ui/ParametersDialog.vue'
import PromptDialog from '~/components/ui/PromptDialog.vue'
import SaveQueryDialog from '~/components/ui/SaveQueryDialog.vue'
import SettingsDialog from '~/components/ui/SettingsDialog.vue'
import ShortcutsDialog from '~/components/ui/ShortcutsDialog.vue'
import BackupDialog, { type BackupDialogProps } from '~/components/workbench/BackupDialog.vue'
import ConnectionDialog from '~/components/workbench/ConnectionDialog.vue'
import CreateTableDialog, { type CreateTableDialogProps, type CreateTableResult } from '~/components/workbench/CreateTableDialog.vue'
import ExportDialog, { type ExportDialogProps } from '~/components/workbench/ExportDialog.vue'
import ImportDialog, { type ImportDialogProps } from '~/components/workbench/ImportDialog.vue'
import StructureChangeDialog, { type StructureChangeDialogProps, type StructureChangeResult } from '~/components/workbench/StructureChangeDialog.vue'

/**
 * The app's dialogs, as functions that resolve with what the user chose.
 *
 * Every opener swallows the dismissal rejection `openModal` raises on Esc,
 * backdrop click or Cancel, so callers only ever branch on the result.
 */
export function useDialogs() {
  /** Resolves with the saved profile, or `null` if the dialog was dismissed. */
  function openConnectionDialog(
    profile: ConnectionProfile | null = null,
    /** `duplicate` starts from `profile` but saves a new one; see `ConnectionDialog`. */
    options: { duplicate?: boolean } = {},
  ) {
    return openModal<ConnectionProfile>(ConnectionDialog, { props: { profile, duplicate: options.duplicate } })
      .catch(() => null)
  }

  /** A confirm dialog with nothing to decide: one OK, for a result to read. */
  function notice(options: { title: string, message: string }) {
    return confirm({ ...options, confirmLabel: 'OK', cancelLabel: '' })
  }

  function confirm(options: {
    title: string
    message: string
    confirmLabel?: string
    cancelLabel?: string
    danger?: boolean
    /** A word to type before the confirm button works; see `ConfirmDialog`. */
    typed?: string
  }) {
    return openModal<boolean>(ConfirmDialog, { props: options })
      .catch(() => false)
  }

  /**
   * Shows one cell at full size. Resolves with the new value when the dialog
   * was editable and the user staged one, and with `null` when it was only
   * read — so a staged NULL stays distinguishable from a dismissal.
   *
   * `bytes` carries a binary cell's whole value as base64, for the viewer to
   * show as a picture or a hex dump; the grid itself only ever holds a digest.
   */
  function openCellValue(cell: {
    column: string
    type: string
    value: CellValue
    editable?: boolean
    bytes?: string
    mimeHint?: string
  }) {
    return openModal<{ value: CellValue }>(CellValueDialog, { props: cell }).catch(() => null)
  }

  /** The Help menu's "About DBison", which before this had no action at all. */
  function openAbout() {
    return openModal(AboutDialog, { props: { version: useRuntimeConfig().public.version } })
      .catch(() => null)
  }

  /** Lists the keystrokes the caller actually has bound; see `ShortcutsDialog`. */
  function openShortcuts(items: { label: string, keys: string }[]) {
    return openModal(ShortcutsDialog, { props: { items } }).catch(() => null)
  }

  /** Asks for one line of text; null when dismissed or left empty. */
  function prompt(options: {
    title: string
    label: string
    value?: string
    placeholder?: string
    confirmLabel?: string
    hint?: string
  }) {
    return openModal<string>(PromptDialog, { props: options }).catch(() => null)
  }

  /** Asks for bind parameter values; null when dismissed. */
  function openParameters(names: string[], values: Record<string, string>) {
    return openModal<Record<string, string>>(ParametersDialog, { props: { names, values } }).catch(() => null)
  }

  function openSettings() {
    return openModal(SettingsDialog).catch(() => null)
  }

  /**
   * Names a statement to keep, or renames one already kept when `existing`
   * is given. Resolves with the query as stored, or null when dismissed.
   */
  function openSaveQuery(options: {
    sql: string
    existing?: SavedQuery | null
    connectionId?: string | null
    database?: string
    schema?: string
  }) {
    return openModal<SavedQuery>(SaveQueryDialog, { props: options }).catch(() => null)
  }

  /**
   * Streams a statement's whole result to a file; see `ExportDialog`.
   * Resolves with what was written, or null when dismissed before that.
   */
  function openExport(options: ExportDialogProps) {
    return openModal<ExportOutcome>(ExportDialog, { props: options }).catch(() => null)
  }

  /**
   * Reads a delimited file into a table; see `ImportDialog`. Resolves with the
   * row count once rows were inserted, so the caller knows to read them again.
   */
  function openImport(options: ImportDialogProps) {
    return openModal<{ inserted: number }>(ImportDialog, { props: options }).catch(() => null)
  }

  /**
   * Dumps a database with the engine's own tool, or restores one; see
   * `BackupDialog`. Resolves with the tool's outcome once it finished, so a
   * caller can re-read a schema a restore just replaced, or null otherwise.
   */
  function openBackup(options: BackupDialogProps) {
    return openModal<ToolOutcome>(BackupDialog, { props: options }).catch(() => null)
  }

  /**
   * One change to a table's structure, previewed as SQL and then run; see
   * `StructureChangeDialog`. Resolves once the statements ran, with what
   * they were, or null when dismissed — nothing was changed in that case.
   */
  function openStructureChange(options: StructureChangeDialogProps) {
    return openModal<StructureChangeResult>(StructureChangeDialog, { props: options }).catch(() => null)
  }

  /**
   * A new table, from a grid of columns; see `CreateTableDialog`. Resolves
   * with the table's name and path once it exists, or null when dismissed.
   */
  function openCreateTable(options: CreateTableDialogProps) {
    return openModal<CreateTableResult>(CreateTableDialog, { props: options }).catch(() => null)
  }

  return {
    openConnectionDialog,
    confirm,
    notice,
    openCellValue,
    openAbout,
    openShortcuts,
    openSettings,
    openParameters,
    prompt,
    openSaveQuery,
    openExport,
    openImport,
    openBackup,
    openStructureChange,
    openCreateTable,
  }
}
