<script setup lang="ts">
import type { MenubarCheckboxItemEmits, MenubarCheckboxItemProps } from 'reka-ui'
import { MenubarCheckboxItem as RekaMenubarCheckboxItem, useForwardPropsEmits } from 'reka-ui'

/**
 * A menu row for something that is either on or off — the explorer being open,
 * the dark theme being the current one.
 *
 * It replaces the "Toggle …" wording the hand-rolled menu used: a tick says
 * what the state *is*, where a verb only says what the click would do and left
 * the user to open the panel to find out which way round it was.
 */
const props = defineProps<MenubarCheckboxItemProps & { hint?: string }>()
const emits = defineEmits<MenubarCheckboxItemEmits>()

const delegated = computed(() => {
  const { hint: _hint, ...rest } = props
  return rest
})

const forwarded = useForwardPropsEmits(delegated, emits)
</script>

<template>
  <RekaMenubarCheckboxItem v-bind="forwarded" class="menu-row">
    <!-- The tick keeps its width when absent, so labels line up with the
         icon-bearing rows in the same menu. -->
    <span class="flex w-[13px] shrink-0 justify-center">
      <AppIcon v-if="modelValue" name="check" :size="13" class="text-accent-bright" />
    </span>
    <span class="flex-1 truncate">
      <slot />
    </span>
    <kbd v-if="hint" class="kbd">{{ hint }}</kbd>
  </RekaMenubarCheckboxItem>
</template>
