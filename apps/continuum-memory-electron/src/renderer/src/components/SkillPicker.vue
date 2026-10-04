<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import MemoryMark from './MemoryMark.vue'
interface SkillOption { id: string; name: string; description?: string }
const props = defineProps<{ modelValue: string; items: SkillOption[]; disabled?: boolean; compact?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const id = `skill-list-${useId()}`
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const opened = ref(false)
const active = ref(0)
const popupStyle = ref<Record<string, string>>({})
const options = computed(() => [{ id: '', name: '自动选择 Skill', description: '根据任务选择已启用的能力' }, ...props.items])
const selected = computed(() => options.value.find(item => item.id === props.modelValue) ?? options.value[0]!)
const label = computed(() => props.compact && !props.modelValue ? 'Skill' : selected.value.name)
function positionPopup() {
  if (!opened.value || !trigger.value) return
  const box = trigger.value.getBoundingClientRect()
  const width = Math.min(320, window.innerWidth - 24)
  const availableAbove = box.top - 16
  const availableBelow = window.innerHeight - box.bottom - 16
  const above = availableAbove >= availableBelow
  popupStyle.value = {
    width: `${width}px`, left: `${Math.max(12, Math.min(box.left, window.innerWidth - width - 12))}px`,
    ...(above ? { bottom: `${window.innerHeight - box.top + 8}px` } : { top: `${box.bottom + 8}px` }),
    maxHeight: `${Math.min(380, Math.max(32, above ? availableAbove - 8 : availableBelow - 8))}px`,
  }
}
function scrollActive() { nextTick(() => document.getElementById(`${id}-${active.value}`)?.scrollIntoView({ block: 'nearest' })) }
function open() {
  if (props.disabled) return
  active.value = Math.max(0, options.value.findIndex(item => item.id === props.modelValue))
  opened.value = true
  positionPopup()
  scrollActive()
}
function choose(index: number) {
  emit('update:modelValue', options.value[index]!.id)
  opened.value = false
  nextTick(() => trigger.value?.focus())
}
function onKeydown(event: KeyboardEvent) {
  if (event.isComposing || props.disabled) return
  if (event.key === 'Tab') { opened.value = false; return }
  if (event.key === 'Escape') { if (opened.value) { event.preventDefault(); event.stopPropagation(); opened.value = false } return }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    if (!opened.value) { open(); return }
    if (event.key === 'Home') active.value = 0
    else if (event.key === 'End') active.value = options.value.length - 1
    else active.value = (active.value + (event.key === 'ArrowDown' ? 1 : -1) + options.value.length) % options.value.length
    scrollActive()
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    if (opened.value) choose(active.value); else open()
  }
}
function outside(event: PointerEvent) { if (event.target instanceof Node && !root.value?.contains(event.target)) opened.value = false }
watch(() => props.disabled, disabled => { if (disabled) opened.value = false })
watch(options, () => { active.value = Math.min(active.value, options.value.length - 1) })
onMounted(() => { document.addEventListener('pointerdown', outside); window.addEventListener('resize', positionPopup); window.addEventListener('scroll', positionPopup, true) })
onUnmounted(() => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', positionPopup); window.removeEventListener('scroll', positionPopup, true) })
</script>
<template>
  <div ref="root" class="skill-picker">
    <button ref="trigger" type="button" class="skill-trigger" role="combobox" :disabled="disabled"
      :aria-label="`本轮 Skill：${selected.name}`" aria-haspopup="listbox" :aria-expanded="opened" :aria-controls="id"
      :aria-activedescendant="opened ? `${id}-${active}` : undefined" :title="selected.name"
      @click="opened ? opened = false : open()" @keydown="onKeydown">
      <MemoryMark /><span class="skill-picker-label">{{ label }}</span>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    <div v-if="opened" :id="id" class="skill-popup" role="listbox" aria-label="选择 Skill" :style="popupStyle">
      <div class="skill-popup-heading">选择 Skill<span>{{ items.length }} 项能力</span></div>
      <button v-for="(item, index) in options" :id="`${id}-${index}`" :key="item.id" type="button" role="option"
        :data-skill-option="item.id" :aria-selected="item.id === modelValue" :class="['skill-option', { focused: index === active }]"
        @pointerdown.prevent @pointermove="active = index" @click="choose(index)">
        <span class="skill-option-copy"><strong>{{ item.name }}</strong><small v-if="item.description">{{ item.description }}</small></span>
        <span v-if="item.id === modelValue" class="skill-option-check" aria-hidden="true">✓</span>
      </button>
    </div>
  </div>
</template>
<style scoped>
.skill-picker { min-width: 0; }
.skill-trigger { display: flex; align-items: center; gap: 7px; width: 100%; min-width: 0; min-height: 34px; padding: 2px 3px; border: 0; border-radius: 20px; background: transparent; color: var(--text); font: inherit; font-size: clamp(12px, .74vw, 15px); cursor: pointer; }
.skill-trigger .memory-mark { width: 21px; height: 21px; }
.skill-trigger > svg:last-child { flex-shrink: 0; }
.skill-picker-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.skill-popup { position: fixed; z-index: 320; overflow-y: auto; padding: 7px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); color: var(--text); box-shadow: 0 12px 38px rgba(0,0,0,.24); color-scheme: var(--color-scheme); }
.skill-popup::-webkit-scrollbar { width: 5px; }
.skill-popup::-webkit-scrollbar-thumb { background: var(--scroll-thumb); border-radius: 8px; }
.skill-popup::-webkit-scrollbar-track { background: transparent; }
.skill-popup-heading { display: flex; justify-content: space-between; padding: 9px 10px 10px; color: var(--text); font-size: 12px; font-weight: 600; }
.skill-popup-heading span { color: var(--text-muted); font-size: 10px; font-weight: 400; }
.skill-option { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px; border: 0; border-radius: 8px; background: var(--surface); color: var(--text); text-align: left; font: inherit; font-size: 13px; cursor: pointer; }
.skill-option.focused { background: var(--accent-soft); }
.skill-option[aria-selected="true"] { box-shadow: inset 2px 0 0 var(--accent-ink); }
.skill-option-copy { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 4px; }
.skill-option strong { color: var(--text); font-weight: 500; }
.skill-option small { color: var(--text-muted); font-size: 11px; line-height: 1.45; }
.skill-option-check { color: var(--accent-ink); }
@media(max-width:640px) { .skill-trigger { font-size: 11px; gap: 3px; min-height: 30px; } }
</style>
