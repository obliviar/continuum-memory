<script setup lang="ts">
import { dialogFocus as vDialogFocus } from '../dialog-focus'
import AppIcon from './AppIcon.vue'
defineProps<{ title: string; busy?: boolean; error?: string }>()
const emit = defineEmits<{ close: []; confirm: [] }>()
</script>
<template>
  <div class="modal-backdrop conversation-delete-backdrop" @pointerdown.self.prevent>
    <section v-dialog-focus="() => !busy && emit('close')" class="chat-feature-dialog conversation-delete-dialog" role="dialog" aria-modal="true" aria-label="删除对话">
      <div class="dialog-header"><div><h2>删除这段对话？</h2><p>此操作无法在界面中恢复</p></div><button class="dialog-close" aria-label="取消删除对话" :disabled="busy" @click="emit('close')"><AppIcon name="close" /></button></div>
      <div class="conversation-delete-body">
      <div class="delete-conversation-name"><AppIcon name="chat" /><strong>{{ title }}</strong></div>
      <p class="delete-conversation-description">聊天记录、草稿和关联收藏将移除，该对话的记忆空间将停用。其他对话、设置和模型不受影响。</p>
      <small class="delete-conversation-audit">加密审计数据仍保留，不进行磁盘彻底擦除。</small>
      <p v-if="error" class="chat-feature-error" role="alert">{{ error }}</p>
      </div>
      <div class="settings-footer"><span /><button class="secondary-btn" data-dialog-autofocus :disabled="busy" @click="emit('close')">取消</button><button class="confirm-conversation-delete" :disabled="busy" @click="emit('confirm')">{{ busy ? '删除中…' : '删除对话' }}</button></div>
    </section>
  </div>
</template>
