<script setup lang="ts">
import { computed } from 'vue'
const props = defineProps<{ name: string }>()
const paths: Record<string, string[]> = {
  trash: ['M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15','M10 10v7M14 10v7'],
  bookmark: ['M6 3h12v19l-6-4-6 4V3Z'],
  archive: ['M3 3h18v5H3Z','M5 8v13h14V8M9 12h6'],
  expand: ['M4 10V4h6M14 4h6v6M20 14v6h-6M10 20H4v-6','M4 4l5 5M20 4l-5 5M20 20l-5-5M4 20l5-5'],
  stop: ['M6 6h12v12H6Z'],
  copy: ['M8 8h12v13H8Z','M16 8V3H3v13h5'],
  quote: ['M10 5H4v7h6V5ZM20 5h-6v7h6V5Z','M10 12c0 4-2 6-6 7M20 12c0 4-2 6-6 7'],
  search: ['M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14','M15 15l6 6'],
  pin: ['M8 3h8l-1 6 4 4H5l4-4-1-6Z','M12 13v8'],
  phrase: ['M5 4h14v13H9l-4 4V4Z','M8 8h8M8 12h5'],
  export: ['M12 3v12M8 11l4 4 4-4','M4 15v6h16v-6'],
  'arrow-right': ['M4 12h16M14 6l6 6-6 6'],
  plus: ['M12 5v14M5 12h14'], chat: ['M20 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 0 1 18 0Z'],
  memory: ['M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z','M17 12a2 2 0 1 0 0 4 2 2 0 0 0 0-4'],
  skill: ['M12 7a5 5 0 1 0 6 6M6 11a5 5 0 1 0 6 6','M10 12h4'],
  document: ['M6 3h8l4 4v14H6Z','M14 3v5h4M9 12h6M9 16h6'],
  sun: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8','M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19'],
  more: ['M12 4v.1M12 12v.1M12 20v.1'],
  volume: ['M3 9h4l5-4v14l-5-4H3Z','M16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14'],
  attachment: ['M8 13 15 6a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2','M5 15 15 5'],
  capture: ['M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5'],
  mic: ['M9 5a3 3 0 0 1 6 0v8a3 3 0 0 1-6 0Z','M5 11v2a7 7 0 0 0 14 0v-2M12 20v3M8 23h8'],
  send: ['M21 3 3 10l7 4 4 7 7-18Z', 'M10 14 21 3'],
  settings: ['M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z','M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6'],
  rename: ['M4 17 17 4l3 3L7 20H4Z','M14 7l3 3'], close: ['M6 6l12 12M18 6 6 18'],
  reset: ['M3 10a9 9 0 1 1 1 8M3 4v6h6'],
}
const strokes = computed(() => paths[props.name] ?? paths.chat!)
</script>
<template><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path v-for="(d, i) in strokes" :key="i" :d="d" :fill="props.name === 'send' && i === 0 ? 'currentColor' : 'none'" /></svg></template>
