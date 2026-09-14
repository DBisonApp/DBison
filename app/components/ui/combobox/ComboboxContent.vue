<script setup lang="ts">
import {
  ComboboxContent as RekaComboboxContent,
  ComboboxPortal as RekaComboboxPortal,
} from 'reka-ui'

/** The dropped list: portalled, collision-aware, dismissed by Esc or outside. */
withDefaults(defineProps<{ sideOffset?: number }>(), { sideOffset: 4 })

/**
 * The root here is the portal, so anything a call site puts on this component
 * would land on a `<Teleport>` and quietly disappear — which is how the picker
 * spent a while ignoring the width it asked for. Attributes are forwarded to
 * the panel itself instead.
 */
defineOptions({ inheritAttrs: false })
</script>

<template>
  <RekaComboboxPortal>
    <RekaComboboxContent
      v-bind="$attrs"
      class="popover popover-panel z-50 flex flex-col overflow-hidden focus:outline-none"
      position="popper"
      :side-offset="sideOffset"
      :collision-padding="8"
    >
      <slot />
    </RekaComboboxContent>
  </RekaComboboxPortal>
</template>
