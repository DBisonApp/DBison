<script setup lang="ts">
import { ModalContent, ModalRoot, ModalTitle, useModalContext } from '@kolirt/vue-modal'

/**
 * The card chrome every dialog shares: backdrop alignment, the panel itself and
 * a titled header. Dialogs built on it deal only with their own content and
 * with `confirm()` / `close()` from the modal context.
 */
withDefaults(defineProps<{ title: string, size?: 'sm' | 'md' | 'lg' }>(), { size: 'md' })

const { close, effectiveOptions } = useModalContext()

// A dialog that refuses Esc and backdrop clicks should not offer a stray X
// either; its own buttons are the only way out.
const dismissible = computed(() => effectiveOptions.value.closeOnInteractOverlay)
</script>

<template>
  <!-- ModalRoot already covers the target; it only carries alignment. -->
  <ModalRoot class="flex items-center justify-center overflow-hidden p-6">
    <!-- Never taller than the window: the card is a column capped at the
         viewport, and whatever a dialog puts in it scrolls inside. A dialog
         that lays itself out as a column with `min-h-0` keeps its own footer
         in view and scrolls only its body. -->
    <ModalContent
      class="app-dialog-card popover relative flex max-h-[calc(100vh-3rem)] w-full flex-col overflow-hidden"
      :class="{ 'max-w-sm': size === 'sm', 'max-w-md': size === 'md', 'max-w-3xl': size === 'lg' }"
    >
      <!-- The signature gradient as a cap rather than a border, so a dialog
           reads as belonging to the app before its title is even parsed. It
           is laid over the top edge and clipped by the card's own rounded
           corners, rather than rounded itself: a two-pixel strip with its
           own radius tapers into points that never match the border's arc. -->
      <div class="app-dialog-cap" aria-hidden="true" />

      <header class="flex items-center justify-between gap-3 border-b border-edge px-4 py-3">
        <ModalTitle class="flex min-w-0 items-center gap-2 font-display text-[15px] font-semibold tracking-wide">
          <AppLogo :size="15" />
          {{ title }}
        </ModalTitle>

        <button
          v-if="dismissible"
          type="button"
          class="btn-icon -mr-1"
          aria-label="Close"
          @click="close()"
        >
          <AppIcon name="close" />
        </button>
      </header>

      <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <slot />
      </div>
    </ModalContent>
  </ModalRoot>
</template>

<style>
/* The gradient cap, along the inside of the card's top edge; the card's
   overflow clip gives it the corners. */
.app-dialog-cap {
  position: absolute;
  inset: 0 0 auto 0;
  height: 2px;
  background-image: var(--app-accent-gradient);
  pointer-events: none;
}

/*
 * Unscoped: `data-state` is set on the ModalContent element itself.
 *
 * Both directions live entirely in the keyframes. Parking the hidden state in
 * the base rule and holding the enter animation with `fill-mode: forwards`
 * looks equivalent but is not: the modal is then never seen to finish its exit
 * animation, and the package waits for that before unmounting the dialog.
 */
.app-dialog-card[data-state="open"] {
  animation: app-dialog-in 140ms ease-out;
}

.app-dialog-card[data-state="closed"] {
  animation: app-dialog-out 100ms ease-in forwards;
}

@keyframes app-dialog-in {
  from { opacity: 0; transform: translateY(6px) scale(0.98); }
}

@keyframes app-dialog-out {
  to { opacity: 0; transform: translateY(6px) scale(0.98); }
}
</style>
