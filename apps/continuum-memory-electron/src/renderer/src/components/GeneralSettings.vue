<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { DEFAULT_CHAT_PREFERENCES, shortcutFromEvent, type ChatPreferences } from '../../../shared/chat-preferences'
import { dialogFocus as vDialogFocus } from '../dialog-focus'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ preferences: ChatPreferences; busy?: boolean; error?: string }>()
const emit = defineEmits<{ close: []; preview: [value: ChatPreferences]; save: [value: ChatPreferences] }>()
const draft = reactive<ChatPreferences>({ reading: { ...props.preferences.reading }, shortcuts: { ...props.preferences.shortcuts }, sendKey: props.preferences.sendKey })
const recording = ref<keyof ChatPreferences['shortcuts'] | null>(null)
const actions = [{ id: 'newConversation' as const, label: '新建对话' }, { id: 'focusInput' as const, label: '聚焦输入框' }, { id: 'search' as const, label: '搜索对话' }]
const value = (): ChatPreferences => ({ reading: { ...draft.reading }, shortcuts: { ...draft.shortcuts }, sendKey: draft.sendKey })
watch(draft, () => emit('preview', value()), { deep: true })
const collision = computed(() => new Set(Object.values(draft.shortcuts)).size < 3)
function onKeydown(event: KeyboardEvent) {
  if (!recording.value || event.isComposing) return
  event.preventDefault(); event.stopPropagation()
  if (event.key === 'Escape') { recording.value = null; return }
  const key = shortcutFromEvent(event)
  if (key) { draft.shortcuts[recording.value] = key; recording.value = null }
}
function reset() { Object.assign(draft, structuredClone(DEFAULT_CHAT_PREFERENCES)); recording.value = null }
</script>
<template>
  <div class="modal-backdrop" @pointerdown.self.prevent>
    <section v-dialog-focus="() => !busy && emit('close')" class="chat-feature-dialog settings-dialog" role="dialog" aria-modal="true" aria-label="通用设置" @keydown.capture="onKeydown">
      <div class="dialog-header"><div><h2>设置</h2><p>阅读与操作偏好</p></div><button class="dialog-close" aria-label="关闭设置" :disabled="busy" @click="emit('close')"><AppIcon name="close" /></button></div>
      <div class="settings-sections">
        <section class="settings-group"><h3>阅读设置</h3>
          <div class="reading-control"><div><label for="reading-font-size">聊天字号</label><strong>{{ draft.reading.fontSize ? `${draft.reading.fontSize}px` : '跟随窗口' }}</strong></div><label class="settings-check"><input type="checkbox" :checked="draft.reading.fontSize === 0" @change="draft.reading.fontSize = ($event.target as HTMLInputElement).checked ? 0 : 16" />自动适应窗口</label><input v-if="draft.reading.fontSize" id="reading-font-size" v-model.number="draft.reading.fontSize" type="range" min="12" max="28" step="1" aria-label="聊天字号" /></div>
          <div class="reading-control"><div><label for="reading-line-height">行距</label><strong>{{ draft.reading.lineHeight.toFixed(2) }}</strong></div><input id="reading-line-height" v-model.number="draft.reading.lineHeight" type="range" min="1.3" max="2.4" step="0.05" aria-label="聊天行距" /></div>
          <div class="reading-control"><div><label for="reading-content-width">阅读宽度</label><strong>{{ draft.reading.contentWidth ? `${draft.reading.contentWidth}px` : '自动' }}</strong></div><label class="settings-check"><input type="checkbox" :checked="draft.reading.contentWidth === 0" @change="draft.reading.contentWidth = ($event.target as HTMLInputElement).checked ? 0 : 900" />自动适应窗口</label><input v-if="draft.reading.contentWidth" id="reading-content-width" v-model.number="draft.reading.contentWidth" type="range" min="560" max="1800" step="20" aria-label="聊天内容宽度" /></div>
          <div class="reading-sample" :style="{ fontSize: `${draft.reading.fontSize || 16}px`, lineHeight: draft.reading.lineHeight }">让信息清晰，让阅读从容。<br />这是聊天正文的字号与行距预览。</div>
        </section>
        <section class="settings-group"><h3>快捷键</h3><div v-for="action in actions" :key="action.id" class="shortcut-row"><span>{{ action.label }}</span><button :aria-label="`设置${action.label}快捷键`" :class="{ recording: recording === action.id }" @click="recording = action.id">{{ recording === action.id ? '请按组合键…' : draft.shortcuts[action.id] }}</button></div><p class="chat-feature-hint">点击按键框录入组合键，Esc 取消录入。</p></section>
        <section class="settings-group"><h3>发送按键</h3><div class="send-key-options"><button :class="{ selected: draft.sendKey === 'enter' }" :aria-pressed="draft.sendKey === 'enter'" @click="draft.sendKey = 'enter'">Enter 发送<span>Shift + Enter 换行</span></button><button :class="{ selected: draft.sendKey === 'ctrl-enter' }" :aria-pressed="draft.sendKey === 'ctrl-enter'" @click="draft.sendKey = 'ctrl-enter'">Ctrl + Enter 发送<span>Enter 换行</span></button></div></section>
      </div>
      <p v-if="error || collision" class="chat-feature-error" role="alert">{{ error || '快捷键存在重复，请为每个操作选择不同按键。' }}</p>
      <div class="settings-footer"><button class="secondary-btn" :disabled="busy" @click="reset">恢复默认</button><span /><button class="secondary-btn" :disabled="busy" @click="emit('close')">取消</button><button class="primary-btn" :disabled="busy || collision || !!recording" @click="emit('save', value())">{{ busy ? '保存中…' : '保存设置' }}</button></div>
    </section>
  </div>
</template>
