<script setup lang="ts">
import { computed, ref } from 'vue'
import type { MessageBookmarkView } from '../../../shared/chat-bookmarks'
import { dialogFocus as vDialogFocus } from '../dialog-focus'
import MessageMarkdown from './MessageMarkdown.vue'
import AppIcon from './AppIcon.vue'
const props = defineProps<{ items: MessageBookmarkView[]; disabled?: boolean }>()
const emit = defineEmits<{ close: []; open: [item: MessageBookmarkView]; remove: [item: MessageBookmarkView]; notice: [message: string] }>()
const query = ref('')
const visible = computed(() => { const q = query.value.trim().toLocaleLowerCase(); return props.items.filter(item => !q || `${item.conversationTitle}\n${item.content}`.toLocaleLowerCase().includes(q)) })
</script>
<template><div class="modal-backdrop" @pointerdown.self.prevent><section v-dialog-focus="() => emit('close')" class="chat-feature-dialog saved-messages-dialog" role="dialog" aria-modal="true" aria-label="收藏消息"><div class="dialog-header"><div><h2>收藏</h2><p>保存值得回看的消息原文</p></div><button class="dialog-close" aria-label="关闭收藏" @click="emit('close')"><AppIcon name="close" /></button></div><label class="conversation-search-input"><AppIcon name="search" /><input v-model="query" data-dialog-autofocus aria-label="搜索收藏" placeholder="搜索收藏内容…" /></label><div class="saved-message-list"><article v-for="item in visible" :key="item.conversationId + item.messageId" class="saved-message-card"><header><strong>{{ item.conversationTitle }}</strong><small>{{ item.role === 'assistant' ? '回答' : '你的消息' }}{{ item.archived ? ' · 已归档' : '' }}</small></header><details><summary><span>{{ item.content.slice(0, 120) }}</span><small>展开全文</small></summary><blockquote v-if="item.quote" class="message-reference">{{ item.quote.content }}</blockquote><MessageMarkdown :content="item.content" @notice="emit('notice', $event)" /></details><footer><button :disabled="disabled || !item.sourceAvailable" @click="emit('open', item)"><AppIcon name="arrow-right" />返回原文</button><small v-if="!item.sourceAvailable">原文已移出近期记录，收藏全文仍保留</small><button @click="emit('remove', item)">取消收藏</button></footer></article><p v-if="!visible.length" class="chat-feature-empty">{{ items.length ? '没有匹配的收藏。' : '在消息下方点击“收藏”，即可在这里回看。' }}</p></div></section></div></template>
