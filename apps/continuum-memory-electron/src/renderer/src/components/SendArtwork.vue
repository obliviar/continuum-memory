<script setup lang="ts">
import { computed, useId } from 'vue'
import approvedBoard from '../assets/approved-ui-board.png'
import { sendReference } from '../send-reference-data'
const props = defineProps<{ theme: string }>()
const clipId = `send-art-${useId()}`
const customGradient = `${clipId}-custom`
const hasReference = computed(() => props.theme in sendReference)
const crop = computed(() => sendReference[props.theme as keyof typeof sendReference] ?? sendReference['thread-teal'])
</script>
<template>
  <svg class="send-artwork" :viewBox="`0 0 ${crop.width} ${crop.height}`" fill="none" aria-hidden="true">
    <defs><clipPath :id="clipId"><path :d="crop.clip" fill-rule="evenodd" /></clipPath><linearGradient :id="customGradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--accent)" /><stop offset="1" stop-color="var(--accent-hover)" /></linearGradient></defs>
    <image v-if="hasReference" :href="approvedBoard" :x="-crop.x" :y="-crop.y" width="1536" height="1024" :clip-path="`url(#${clipId})`" />
    <g v-else :clip-path="`url(#${clipId})`"><path :d="crop.clip" :fill="`url(#${customGradient})`" /><path d="M37 15 15 24l9 5 5 10 8-24Z" fill="var(--on-accent)" /></g>
  </svg>
</template>
