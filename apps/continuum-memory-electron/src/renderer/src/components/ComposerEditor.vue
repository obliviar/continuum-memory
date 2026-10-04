<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { dialogFocus as vDialogFocus } from '../dialog-focus'
import AppIcon from './AppIcon.vue'
import type { EditorSelection } from '../../../shared/chat-ui'
const props = defineProps<{ modelValue: string; selection: EditorSelection; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string]; close: [selection: EditorSelection]; send: [selection: EditorSelection] }>()
const textarea = ref<HTMLTextAreaElement | null>(null)
function selection(): EditorSelection { const t = textarea.value; return t ? { start: t.selectionStart, end: t.selectionEnd, direction: t.selectionDirection, scrollTop: t.scrollTop } : props.selection }
onMounted(() => nextTick(() => { const t = textarea.value; t?.focus(); t?.setSelectionRange(props.selection.start, props.selection.end, props.selection.direction); if (t) t.scrollTop = props.selection.scrollTop }))
</script>
<template><div class="modal-backdrop" @pointerdown.self.prevent><section v-dialog-focus="() => emit('close', selection())" class="chat-feature-dialog composer-editor-dialog" role="dialog" aria-modal="true" aria-label="展开输入框"><div class="dialog-header"><div><h2>编辑消息</h2><p>Enter 换行 · Esc 收起并保留内容</p></div><button class="dialog-close" aria-label="收起输入框" @click="emit('close', selection())"><AppIcon name="close" /></button></div><textarea ref="textarea" :value="modelValue" class="expanded-message-input" aria-label="展开的聊天消息" maxlength="200000" placeholder="在这里整理长文…" :disabled="disabled" @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)" /><div class="settings-footer"><small>{{ modelValue.length }} 字</small><span /><button class="secondary-btn" @click="emit('close', selection())">收起并保留</button><button class="primary-btn" :disabled="disabled || !modelValue.trim()" @click="emit('send', selection())">发送</button></div></section></div></template>
