<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import type { ConversationListItem, ConversationSearchResult } from '../../../shared/chat-ui'
import { ipcRenderer } from '../conversation-ipc'
import { dialogFocus as vDialogFocus } from '../dialog-focus'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ conversations: ConversationListItem[]; disabled?: boolean; archivedOnly?: boolean }>()
const emit = defineEmits<{ close: []; select: [result: ConversationSearchResult]; pin: [id: string, pinned: boolean]; archive: [id: string, archived: boolean] }>()
const query = ref(''), results = ref<ConversationSearchResult[]>([]), error = ref(''), loading = ref(false)
const visible = computed<ConversationSearchResult[]>(() => {
  const all = query.value.trim() ? results.value : props.conversations
  return [...all].filter(item => props.archivedOnly ? item.archived : (query.value.trim() || !item.archived)).sort((a,b) => Number(!!b.pinned)-Number(!!a.pinned))
})
let revision = 0, timer: ReturnType<typeof setTimeout> | undefined
watch(query, () => {
  const current = ++revision
  clearTimeout(timer)
  error.value = ''
  results.value = []
  loading.value = !!query.value.trim()
  if (!loading.value) return
  timer = setTimeout(async () => {
    try {
      const response = await ipcRenderer.invoke('conversations:search', query.value.trim())
      if (current !== revision) return
      if (!response.ok) throw new Error(response.error)
      results.value = response.items
    } catch (e) { if (current === revision) error.value = e instanceof Error ? e.message : '搜索失败，请重试。' }
    finally { if (current === revision) loading.value = false }
  }, 180)
})
watch(() => props.conversations, conversations => {
  results.value = results.value.map(result => ({ ...result, pinned: conversations.find(c => c.id === result.id)?.pinned, archived: conversations.find(c => c.id === result.id)?.archived }))
    .sort((a,b) => Number(!!b.pinned)-Number(!!a.pinned))
})
onUnmounted(() => { revision++; clearTimeout(timer) })
</script>
<template>
  <div class="modal-backdrop" @pointerdown.self.prevent>
    <section v-dialog-focus="() => emit('close')" class="chat-feature-dialog conversation-search-dialog" role="dialog" aria-modal="true" :aria-label="archivedOnly ? '归档对话' : '搜索对话'">
      <div class="dialog-header"><div><h2>{{ archivedOnly ? '归档对话' : '搜索对话' }}</h2><p>{{ archivedOnly ? '恢复对话，保留原有记忆空间' : '查找标题和聊天原文' }}</p></div><button class="dialog-close" aria-label="关闭搜索" @click="emit('close')"><AppIcon name="close" /></button></div>
      <label class="conversation-search-input"><AppIcon name="search" /><input v-model="query" data-dialog-autofocus maxlength="200" aria-label="搜索历史对话" placeholder="输入关键词，例如项目名称…" /></label>
      <p class="chat-feature-hint" role="status">{{ error || (loading ? '正在搜索…' : `${visible.length} 段对话`) }}</p>
      <div class="conversation-search-results">
        <div v-for="result in visible" :key="result.id" class="conversation-search-result">
          <button class="search-result-open" :disabled="disabled" @click="emit('select', result)"><AppIcon name="chat" /><span><strong>{{ result.title }}</strong><small v-if="result.archived">已归档</small><small v-if="result.snippet">{{ result.snippet }}</small><small v-else>{{ result.pinned ? '已置顶' : '独立记忆空间' }}</small></span><AppIcon name="arrow-right" /></button>
          <button v-if="result.archived" class="search-result-restore" aria-label="恢复归档对话" @click="emit('archive', result.id, false)">恢复</button>
          <button class="search-result-pin" :class="{ pinned: result.pinned }" :aria-label="result.pinned ? '取消置顶' : '置顶对话'" :aria-pressed="!!result.pinned" @click="emit('pin', result.id, !result.pinned)"><AppIcon name="pin" /></button>
        </div>
        <p v-if="!loading && !error && !visible.length" class="chat-feature-empty">没有找到匹配的对话，试试更短的关键词。</p>
      </div>
    </section>
  </div>
</template>
