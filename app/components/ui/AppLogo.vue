<script setup lang="ts">
/**
 * The bison mark.
 *
 * Front-facing head: a shaggy crown, a blunt muzzle, and horns tucked into the
 * temples so they read as attached rather than floating.
 *
 * Three details are load-bearing, because without them this is a cattle skull —
 * the western motif is exactly "pale head + horns + holes":
 *   - the crown is scalloped, not domed; fur is the difference between an
 *     animal and a bone
 *   - the eyes are small and set out at the edge of the head, where a prey
 *     animal's are, rather than large and forward like eye sockets
 *   - there are no nostril cutouts at all; a hole pair below the eyes is the
 *     nasal cavity, and it drags the whole shape back to a skull
 * They cost nothing at 14px, where the eyes close up and the silhouette carries
 * the mark on its own.
 *
 * `tone`:
 *   - `brand`  the signature gradient, with the one warm accent on the horns
 *   - `current` a flat `currentColor`, for when the mark is just an icon
 */
const props = withDefaults(
  defineProps<{ size?: number, tone?: 'brand' | 'current' }>(),
  { size: 16, tone: 'brand' },
)

// Gradients are document-scoped, so two marks on one screen would otherwise
// share — and fight over — a single `id`.
const uid = useId()
const fillId = `bison-fill-${uid}`

const headFill = computed(() => (props.tone === 'brand' ? `url(#${fillId})` : 'currentColor'))
const hornStroke = computed(() => (props.tone === 'brand' ? 'var(--app-brand-warm)' : 'currentColor'))
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
    class="shrink-0 overflow-visible"
  >
    <defs v-if="tone === 'brand'">
      <linearGradient :id="fillId" x1="4" y1="3" x2="20" y2="21" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="var(--app-accent-bright)" />
        <stop offset="100%" stop-color="var(--app-accent-alt)" />
      </linearGradient>
    </defs>

    <!-- Horns first, so the head overlaps where they meet it. -->
    <g
      :stroke="hornStroke"
      stroke-width="2.1"
      stroke-linecap="round"
      fill="none"
    >
      <path d="M7.6 8.4C4.6 9.2 2.4 7.9 2.1 4.7" />
      <path d="M16.4 8.4C19.4 9.2 21.6 7.9 21.9 4.7" />
    </g>

    <!--
      One path so the eyes are punched through the head rather than painted over
      it: with `evenodd` the mark keeps working on any background, including the
      tinted surface it sits on in the menu bar.
    -->
    <path
      :fill="headFill"
      fill-rule="evenodd"
      d="M5.8 8.8C5.5 6.8 6.7 5.4 8.1 5.2C8.5 4 9.7 3.6 10.3 4.5C10.8 3.6 11.6 3.4 12 4.2C12.4 3.4 13.2 3.6 13.7 4.5C14.3 3.6 15.5 4 15.9 5.2C17.3 5.4 18.5 6.8 18.2 8.8C18 10.5 17.2 11.8 16.2 12.5L15.7 15C15.7 16.9 14.2 18.8 12 18.8C9.8 18.8 8.3 16.9 8.3 15L7.8 12.5C6.8 11.8 6 10.5 5.8 8.8ZM8.18 10.5A0.62 0.62 0 1 0 9.42 10.5A0.62 0.62 0 1 0 8.18 10.5ZM14.58 10.5A0.62 0.62 0 1 0 15.82 10.5A0.62 0.62 0 1 0 14.58 10.5Z"
    />
  </svg>
</template>
