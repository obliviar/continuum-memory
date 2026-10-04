<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { renderMarkdown } from '../markdown'
import { ipcRenderer } from '../conversation-ipc'

const props = defineProps<{ content: string; streaming?: boolean }>()
const emit = defineEmits<{ notice: [message: string] }>()
const displayed = ref(props.content)
let timer: ReturnType<typeof setTimeout> | undefined
watch([() => props.content, () => props.streaming], () => {
  if (!props.streaming) { clearTimeout(timer); timer = undefined; displayed.value = props.content }
  else if (!timer) timer = setTimeout(() => { displayed.value = props.content; timer = undefined }, 50)
})
onUnmounted(() => clearTimeout(timer))
const rendered = computed(() => renderMarkdown(displayed.value))

async function onClick(event: MouseEvent) {
  if (!(event.target instanceof Element)) return
  const button = event.target.closest<HTMLButtonElement>('button[data-code-index]')
  try {
    if (button) {
      const code = rendered.value.blocks[Number(button.dataset.codeIndex)]
      if (code === undefined) return
      const result = await ipcRenderer.invoke('chat-ui:copy', code)
      if (!result.ok) throw new Error(result.error)
      emit('notice', '代码已复制')
    } else {
      const link = event.target.closest<HTMLAnchorElement>('a[href]')
      if (!link) return
      event.preventDefault()
      const result = await ipcRenderer.invoke('chat-ui:open-link', link.getAttribute('href'))
      if (!result.ok) throw new Error(result.error)
    }
  } catch (error) { emit('notice', error instanceof Error ? error.message : '操作失败，请重试。') }
}
</script>
<template><div class="message-markdown" @click="onClick" v-html="rendered.html" /></template>
