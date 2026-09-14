<script setup lang="ts">
import type { ContextMenuItemEmits, ContextMenuItemProps } from 'reka-ui'
import { ContextMenuItem as RekaContextMenuItem, useForwardPropsEmits } from 'reka-ui'
import type { IconName } from '~/components/ui/AppIcon.vue'

/** A command, shaped like the menu-bar rows so the two read as one system. */
const props = defineProps<ContextMenuItemProps & {
  icon?: IconName
  hint?: string
  /** Draws the row as destructive; it still needs its own confirmation. */
  danger?: boolean
}>()
const emits = defineEmits<ContextMenuItemEmits>()

const delegated = computed(() => {
  const { icon: _icon, hint: _hint, danger: _danger, ...rest } = props
  return rest
})

const forwarded = useForwardPropsEmits(delegated, emits)
</script>

<template>
  <RekaContextMenuItem
    v-bind="forwarded"
    class="menu-row"
    :class="danger ? 'text-danger data-[highlighted]:bg-danger/15 data-[highlighted]:text-danger' : ''"
  >
    <AppIcon v-if="icon" :name="icon" :size="13" class="opacity-70" />
    <span class="flex-1 truncate">
      <slot />
    </span>
    <kbd v-if="hint" class="kbd">{{ hint }}</kbd>
  </RekaContextMenuItem>
</template>
