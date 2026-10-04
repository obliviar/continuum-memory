<script setup lang="ts">
import { nextTick, ref } from 'vue'
import type { QuickPhrase } from '../../../shared/chat-ui'
import { ipcRenderer } from '../conversation-ipc'
import { dialogFocus as vDialogFocus } from '../dialog-focus'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ phrases: QuickPhrase[]; disabled?: boolean }>()
const emit = defineEmits<{ close: []; insert: [content: string]; updated: [phrases: QuickPhrase[]] }>()
const editing = ref<string | null>(null), name = ref(''), content = ref(''), error = ref(''), busy = ref(false), deleting = ref('')
function edit(phrase?: QuickPhrase) { editing.value = phrase?.id ?? ''; name.value = phrase?.name ?? ''; content.value = phrase?.content ?? ''; error.value = ''; deleting.value = ''; nextTick(() => document.querySelector<HTMLInputElement>('.phrase-editor input')?.focus()) }
async function save(next: QuickPhrase[]) {
  if (busy.value) return false
  busy.value = true; error.value = ''
  try {
    const result = await ipcRenderer.invoke('chat-ui:phrases-save', next.map(item => ({ id: item.id, name: item.name, content: item.content })))
    if (!result.ok) throw new Error(result.error)
    emit('updated', result.phrases)
    return true
  } catch (e) { error.value = e instanceof Error ? e.message : '保存失败，请重试。'; return false }
  finally { busy.value = false }
}
async function saveEditing() {
  if (!name.value.trim() || !content.value.trim()) { error.value = '请填写短语名称和内容。'; return }
  const item = { id: editing.value || crypto.randomUUID(), name: name.value.trim(), content: content.value }
  const next = editing.value ? props.phrases.map(p => p.id === editing.value ? item : p) : [...props.phrases, item]
  if (await save(next)) editing.value = null
}
async function remove(id: string) {
  if (deleting.value !== id) { deleting.value = id; return }
  if (await save(props.phrases.filter(p => p.id !== id))) deleting.value = ''
}
</script>
<template>
  <div class="modal-backdrop" @pointerdown.self.prevent>
    <section v-dialog-focus="() => !busy && emit('close')" class="chat-feature-dialog phrases-dialog" role="dialog" aria-modal="true" aria-label="快捷短语">
      <div class="dialog-header"><div><h2>快捷短语</h2><p>点击填入输入框，发送前可以继续修改</p></div><button class="dialog-close" aria-label="关闭快捷短语" :disabled="busy" @click="emit('close')"><AppIcon name="close" /></button></div>
      <p v-if="error" class="chat-feature-error" role="alert">{{ error }}</p>
      <form v-if="editing !== null" class="phrase-editor" @submit.prevent="saveEditing">
        <label>名称<input v-model="name" class="settings-input" aria-label="短语名称" maxlength="40" placeholder="例如：整理成表格" :disabled="busy" /></label>
        <label>内容<textarea v-model="content" class="settings-input" aria-label="短语内容" maxlength="4000" rows="5" placeholder="输入常用要求…" :disabled="busy" /></label>
        <div class="phrase-editor-actions"><button type="button" class="secondary-btn" :disabled="busy" @click="editing = null">取消</button><button class="primary-btn" :disabled="busy || !name.trim() || !content.trim()">{{ busy ? '保存中…' : '保存短语' }}</button></div>
      </form>
      <div v-else class="phrase-list">
        <div v-for="phrase in phrases" :key="phrase.id" class="phrase-item">
          <button class="phrase-insert" :disabled="disabled || busy" :data-phrase-id="phrase.id" @click="emit('insert', phrase.content)"><span><strong>{{ phrase.name }}</strong><small>{{ phrase.content }}</small></span><AppIcon name="arrow-right" /></button>
          <div class="phrase-actions"><button :disabled="busy" :aria-label="`编辑短语：${phrase.name}`" @click="edit(phrase)"><AppIcon name="rename" />编辑</button><button :disabled="busy" :aria-label="`删除短语：${phrase.name}`" @click="remove(phrase.id)">{{ deleting === phrase.id ? '确认删除' : '删除' }}</button></div>
        </div>
        <p v-if="!phrases.length" class="chat-feature-empty">保存常用要求，下次不用重复输入。</p>
        <button class="phrase-add" :disabled="busy || phrases.length >= 50" @click="edit()"><AppIcon name="plus" />添加快捷短语</button>
      </div>
    </section>
  </div>
</template>
