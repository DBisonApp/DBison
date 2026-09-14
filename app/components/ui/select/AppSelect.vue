<script setup lang="ts">
import {
  SelectContent as RekaSelectContent,
  SelectIcon as RekaSelectIcon,
  SelectItem as RekaSelectItem,
  SelectItemIndicator as RekaSelectItemIndicator,
  SelectItemText as RekaSelectItemText,
  SelectPortal as RekaSelectPortal,
  SelectRoot as RekaSelectRoot,
  SelectTrigger as RekaSelectTrigger,
  SelectValue as RekaSelectValue,
  SelectViewport as RekaSelectViewport,
} from 'reka-ui'

/**
 * A single-choice picker, as one component rather than a kit.
 *
 * The parts a `<select>` has no use for — a per-item slot, a group header —
 * are not worth the six-file ceremony here, so the options come in as data and
 * the whole control is one tag. What it buys over the native element is that
 * its list is real DOM: a native popup is drawn by the OS outside the page, and
 * inside a Reka popover that reads as a click *outside* the panel, which shuts
 * the panel the moment the user opens the dropdown in it.
 */
withDefaults(
  defineProps<{
    options: { value: string, label: string }[]
    placeholder?: string
    disabled?: boolean
  }>(),
  { placeholder: 'Pick one', disabled: false },
)

const model = defineModel<string | null>({ default: null })
</script>

<template>
  <RekaSelectRoot v-model="model" :disabled="disabled">
    <RekaSelectTrigger
      class="field flex items-center gap-2 disabled:opacity-50 data-[placeholder]:text-faint"
    >
      <RekaSelectValue class="min-w-0 flex-1 truncate text-left" :placeholder="placeholder" />
      <RekaSelectIcon as-child>
        <AppIcon name="chevronDown" :size="12" class="text-faint" />
      </RekaSelectIcon>
    </RekaSelectTrigger>

    <RekaSelectPortal>
      <RekaSelectContent
        class="popover popover-panel z-[60] overflow-hidden"
        position="popper"
        :side-offset="4"
        :collision-padding="8"
      >
        <!-- Matching the trigger's width keeps a long database name from
             blowing the panel out past the popover it was opened inside. -->
        <RekaSelectViewport class="max-h-72 min-w-[var(--reka-select-trigger-width)] overflow-auto p-1">
          <RekaSelectItem
            v-for="option in options"
            :key="option.value"
            :value="option.value"
            class="menu-row"
          >
            <span class="flex w-[13px] shrink-0 justify-center">
              <RekaSelectItemIndicator as-child>
                <AppIcon name="check" :size="13" class="text-accent-bright" />
              </RekaSelectItemIndicator>
            </span>
            <RekaSelectItemText class="min-w-0 flex-1 truncate">
              {{ option.label }}
            </RekaSelectItemText>
          </RekaSelectItem>
        </RekaSelectViewport>
      </RekaSelectContent>
    </RekaSelectPortal>
  </RekaSelectRoot>
</template>
