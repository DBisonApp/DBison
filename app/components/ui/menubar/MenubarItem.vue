<script setup lang="ts">
import type { MenubarItemEmits, MenubarItemProps } from 'reka-ui'
import { MenubarItem as RekaMenubarItem, useForwardPropsEmits } from 'reka-ui'
import type { IconName } from '~/components/ui/AppIcon.vue'

/**
 * A command in a menu: an icon, a label, and the keystroke that does the same
 * thing without opening the menu.
 *
 * The hint is only ever passed by `AppMenuBar`, which reads it off the shortcut
 * registry rather than typing it out — a menu that advertises a key nothing
 * listens for is worse than one that advertises nothing.
 */
const props = defineProps<MenubarItemProps & { icon?: IconName, hint?: string }>()
const emits = defineEmits<MenubarItemEmits>()

const delegated = computed(() => {
  const { icon: _icon, hint: _hint, ...rest } = props
  return rest
})

const forwarded = useForwardPropsEmits(delegated, emits)
</script>

<template>
  <RekaMenubarItem v-bind="forwarded" class="menu-row">
    <AppIcon v-if="icon" :name="icon" :size="13" class="opacity-70" />
    <span class="flex-1 truncate">
      <slot />
    </span>
    <kbd v-if="hint" class="kbd">{{ hint }}</kbd>
  </RekaMenubarItem>
</template>
