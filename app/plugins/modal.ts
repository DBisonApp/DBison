import { createModal, type DefineGroups } from '@kolirt/vue-modal'

/**
 * Dialogs are opened imperatively (`openModal(...)` → awaited result) instead of
 * each caller owning an `open` ref and repeating the overlay markup. That also
 * moves them out of the dockview panel subtree they used to render inside,
 * where a closing panel took its dialog with it.
 *
 * Two groups, layered by `<AppModalHost>`:
 *  - `dialog`  — regular content dialogs, dismissible the usual ways.
 *  - `confirm` — decisions that must be answered, so Esc and backdrop clicks
 *                are disabled; it renders above `dialog` and may stack on one.
 */
declare module '@kolirt/vue-modal' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ModalGroupRegistry extends DefineGroups<['dialog', 'confirm']> {}
}

export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.use(
    createModal({
      groups: {
        dialog: {},
        confirm: {
          disableCloseOnEscape: true,
          disableCloseOnInteractOverlay: true,
          disableCloseOnInteractOutside: true,
        },
      },
    }),
  )
})
