<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core'
import type { NodeProps } from '@vue-flow/core'
import type { ErdNodeData } from '~/utils/erd-graph'

/**
 * One table in the ER diagram: its name across the top, a row per column.
 *
 * Every row carries two invisible handles, one on each edge, so a foreign key
 * is drawn from the column that holds it to the column it names rather than
 * from box to box. The box's height is what `erd-graph.ts` told dagre it would
 * be, so the row height there and the row height here are the same number.
 */

const props = defineProps<NodeProps<ErdNodeData>>()

const emit = defineEmits<{ open: [] }>()

const isView = computed(() => props.data.object.kind === 'view')
</script>

<template>
  <div
    class="erd-table flex flex-col overflow-hidden rounded-md border bg-surface shadow-app-md"
    :class="[
      selected ? 'border-accent-bright shadow-glow' : data.focused ? 'border-accent-line' : 'border-edge-strong',
    ]"
    :style="{ width: `${NODE_WIDTH}px` }"
  >
    <!-- Double-click opens the data grid: the diagram says what a table is
         shaped like, the grid says what is in it. -->
    <div
      class="flex items-center gap-1.5 border-b border-edge px-2 font-medium"
      :class="data.focused ? 'bg-accent-soft' : 'bg-raised/60'"
      :style="{ height: `${HEADER_HEIGHT}px` }"
      :title="`Double-click to open ${data.label}`"
      @dblclick="emit('open')"
    >
      <AppIcon
        :name="isView ? 'view' : 'table'"
        :size="13"
        :class="isView ? 'text-info' : 'text-muted'"
      />
      <span class="truncate">{{ data.label }}</span>
      <span class="ml-auto shrink-0 text-[11px] font-normal text-faint">{{ data.columns.length }}</span>
    </div>

    <div class="py-[3px]">
      <div
        v-for="column in data.columns"
        :key="column.name"
        class="relative flex items-center gap-1.5 px-2"
        :style="{ height: `${ROW_HEIGHT}px` }"
        :title="`${column.name} · ${column.type}${column.nullable ? '' : ' · not null'}`"
      >
        <Handle
          :id="targetHandle(column.name)"
          type="target"
          :position="Position.Left"
          class="erd-handle"
        />

        <AppIcon
          :name="column.primaryKey ? 'key' : column.foreignKey ? 'link' : 'column'"
          :size="11"
          :class="column.primaryKey ? 'text-warning' : column.foreignKey ? 'text-accent-bright' : 'text-faint'"
        />

        <span class="truncate" :class="column.primaryKey ? 'font-medium text-content' : 'text-content/90'">
          {{ column.name }}
        </span>

        <span class="ml-auto shrink-0 truncate pl-2 font-mono text-[10px] text-faint">{{ column.type }}</span>

        <Handle
          :id="sourceHandle(column.name)"
          type="source"
          :position="Position.Right"
          class="erd-handle"
        />
      </div>
    </div>
  </div>
</template>

<style>
/*
 * The handles exist so an edge has a row to attach to; nobody drags a new key
 * out of a diagram, so they are not drawn. Unscoped, because Vue Flow renders
 * them with its own classes and `.erd-handle` is the hook this component
 * leaves on them.
 */
.erd-table .erd-handle {
  width: 1px;
  height: 1px;
  min-width: 0;
  min-height: 0;
  border: none;
  background: transparent;
  pointer-events: none;
}
</style>
