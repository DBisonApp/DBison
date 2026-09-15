<script setup lang="ts">
import { encode } from 'uqr'

/**
 * A QR code, drawn as an SVG from the module grid `uqr` computes, entirely in
 * the renderer: nothing is fetched and no markup is injected. It always
 * renders dark on white with the standard four-module quiet zone, whatever
 * the theme, because phone cameras read inverted or borderless codes badly.
 */
const props = withDefaults(defineProps<{ value: string, size?: number, label: string }>(), { size: 128 })

const QUIET_ZONE = 4

const qr = computed(() => {
  const { size, data } = encode(props.value, { ecc: 'M', border: 0 })
  let path = ''
  data.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) path += `M${x} ${y}h1v1h-1z`
  }))
  return { size, path }
})
</script>

<template>
  <svg
    :width="props.size"
    :height="props.size"
    :viewBox="`${-QUIET_ZONE} ${-QUIET_ZONE} ${qr.size + QUIET_ZONE * 2} ${qr.size + QUIET_ZONE * 2}`"
    shape-rendering="crispEdges"
    role="img"
    :aria-label="label"
  >
    <rect
      :x="-QUIET_ZONE"
      :y="-QUIET_ZONE"
      :width="qr.size + QUIET_ZONE * 2"
      :height="qr.size + QUIET_ZONE * 2"
      fill="#fff"
    />
    <path :d="qr.path" fill="#000" />
  </svg>
</template>
