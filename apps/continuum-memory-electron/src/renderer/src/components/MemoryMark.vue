<script setup lang="ts">
import { computed, inject } from 'vue'
import { APP_ICON_THEME, appIconUrl } from '../app-icon'
import MemoryGlyph from './MemoryGlyph.vue'

const props = defineProps<{ theme?: string }>()
const inheritedTheme = inject(APP_ICON_THEME, computed(() => 'thread-teal'))
const theme = computed(() => props.theme ?? inheritedTheme.value)
const custom = computed(() => theme.value === 'custom' || theme.value.startsWith('custom:'))
const source = computed(() => appIconUrl(theme.value))
</script>
<template>
  <MemoryGlyph v-if="custom" />
  <img v-else :src="source" :data-icon-theme="theme" class="memory-mark app-icon-image" alt="" aria-hidden="true" draggable="false" />
</template>
