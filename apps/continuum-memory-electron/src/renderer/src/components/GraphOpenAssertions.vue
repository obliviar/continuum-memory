<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { GraphOpenAssertionRecord, OpenAssertionSearchHit } from '@continuum-memory/memory'

const props = defineProps<{ ready: boolean; busy: boolean; items: GraphOpenAssertionRecord[];
  sources: Array<{ id: string; text: string; sourceId: string }> }>()
const emit = defineEmits<{ refresh: []; busy: [value: boolean] }>()
const { ipcRenderer } = (window as any).require('electron')
const working = ref(false), query = ref(''), targets = ref(''), sourceId = ref('')
const includeCandidates = ref(false)
const automaticCount = computed(() => props.items.filter(item => item.review.status === 'candidate'
  && item.admission?.localNavigation === 'automatic').length)
const searchMode = ref('')
const hits = ref<OpenAssertionSearchHit[]>([]), sourceHits = ref<Array<{ id: string; text: string }>>([])
const message = ref(''), failed = ref(false)
watch(() => props.items, () => { hits.value = []; sourceHits.value = []; searchMode.value = '' })

async function request(channel: string, input: Record<string, unknown>, onSuccess: (result: any) => void) {
  if (working.value || props.busy) return
  working.value = true; emit('busy', true); failed.value = false; message.value = '正在处理…'
  try {
    const result = await ipcRenderer.invoke(channel, input)
    if (!result?.ok) throw new Error(result?.error || '操作失败。')
    onSuccess(result)
  } catch (error) {
    failed.value = true
    message.value = error instanceof Error ? error.message : String(error)
  } finally { working.value = false; emit('busy', false) }
}

function review(item: GraphOpenAssertionRecord, outcome: 'accepted' | 'rejected') {
  return request('memory:graph-open-review', { id: item.ref.id, sourceRevision: item.extraction.sourceRevision, outcome,
    reason: outcome === 'accepted' ? '用户确认关系与参与对象忠实于原文；保留未知语境' : '用户拒绝或撤销开放断言' }, () => {
    hits.value = []; sourceHits.value = []; emit('refresh')
    message.value = outcome === 'accepted' ? '已确认开放断言，可在本地关联搜索中查询。' : '已拒绝或撤销开放断言。'
  })
}
function search() {
  if (!query.value.trim()) return
  return request('memory:graph-open-search', { query: query.value, maximumDepth: 2, includeCandidates: includeCandidates.value }, result => {
    hits.value = result.items ?? []; sourceHits.value = result.sources ?? []
    searchMode.value = result.semantic?.mode === 'context-vector'
      ? `本地语境向量辅助排序（比较 ${result.semantic.compared} 条${result.semantic.truncated ? '；本次预算有限，未覆盖全部记录' : ''}）`
      : '文本关联回退（本地语义模型未启用或不可用）'
    message.value = `找到 ${hits.value.length} 条相关开放断言、${sourceHits.value.length} 条原文。`
  })
}
function extract() {
  if (!sourceId.value || !targets.value.trim()) return
  return request('memory:graph-custom-extract', { sourceId: sourceId.value, targets: targets.value }, () => {
    emit('refresh'); message.value = '已按补充目标提取，请检查开放断言候选。'
  })
}
</script>

<template>
  <section v-if="ready" class="memory-review-panel">
    <strong>开放关系与事件</strong>
    <p class="field-hint">明确、低风险的原文关系可自动用于本地关联查询，无需逐条确认；本页显示列表中有 {{ automaticCount }} 条自动准入记录。不确定内容按需核实。入图不代表事实成立，同名对象不会自动合并。</p>
    <details>
    <summary>按需核对与管理开放记录（当前列表 {{ items.length }} 条）</summary>
    <div class="open-items">
    <div v-for="item in items" :key="item.ref.id" class="memory-review-item">
      <div><strong>{{ item.relationText }}</strong> · {{ item.review.status === 'accepted' ? '用户已确认' : item.admission?.localNavigation === 'automatic' ? '自动准入本地查询，非事实确认' : '按需核实候选' }}</div>
      <div>原文：{{ item.text }}</div>
      <div v-for="participant in item.participants" :key="`${participant.ref.id}:${participant.role}`" class="field-hint">{{ participant.role }}：{{ participant.text }}（类型候选：{{ participant.typeCandidate }}）</div>
      <div v-for="attribute in item.attributes" :key="attribute.role" class="field-hint">{{ attribute.role }}：{{ attribute.value }}</div>
      <details v-if="item.sourceContext"><summary>回溯原文语境</summary>{{ item.sourceContext.text }}<div class="field-hint">{{ item.sourceContext.truncated ? '语境窗口有截断，保留不确定性' : '当前用户消息语境；不代表引述者已解析' }}</div></details>
      <div v-if="item.admission?.reasons.length" class="field-hint">准入依据/限制：{{ item.admission.reasons.join('；') }}</div>
      <button v-if="item.review.status === 'candidate'" class="secondary-btn" :disabled="busy || working" @click="review(item, 'accepted')">确认与原文一致</button>
      <button class="secondary-btn" :disabled="busy || working" @click="review(item, 'rejected')">{{ item.review.status === 'accepted' ? '撤销确认' : '拒绝' }}</button>
    </div>
    </div>
    </details>
    <input v-model="query" class="settings-input" placeholder="查询实体或信息，例如：样品 S7" maxlength="500" @keydown.enter="search" />
    <label class="field-hint"><input v-model="includeCandidates" type="checkbox" :disabled="busy || working" />同时显示未核实关联候选（带原文，不作为已确认事实）</label>
    <button class="secondary-btn" :disabled="busy || working || !query.trim()" @click="search">搜索相关开放记忆</button>
    <div v-if="searchMode" class="field-hint">{{ searchMode }}；相似度仅表示相关性，不决定审核或实体身份。</div>
    <div v-for="hit in hits" :key="hit.assertion.ref.id" class="memory-review-item">
      <div>{{ hit.assertion.text }}</div>
      <div class="field-hint">{{ hit.route === 'context-vector-candidate' ? '语境向量相关候选' : hit.depth === 0 ? '直接匹配' : `经「${hit.via?.mentionText}」找到的相关候选；同名不等于同一实体` }} · {{ hit.depth }} 跳 · {{ hit.verification === 'user-confirmed' ? '用户确认' : hit.verification === 'automatic-navigation' ? '自动准入查询，非事实确认' : '未核实候选' }}</div>
      <div v-if="hit.via?.contextSimilarity !== undefined" class="field-hint">关联两条记录的语境相似度：{{ hit.via.contextSimilarity.toFixed(3) }}（不是同一实体的证明）</div>
      <details v-if="hit.assertion.sourceContext"><summary>查看语境</summary>{{ hit.assertion.sourceContext.text }}</details>
      <button v-if="hit.assertion.review?.status === 'candidate'" class="secondary-btn" :disabled="busy || working" @click="review(hit.assertion, 'accepted')">按需确认与原文一致</button>
    </div>
    <details v-if="sourceHits.length">
      <summary>匹配的原文（保留来源，不代表关系已审核）</summary>
      <div v-for="source in sourceHits" :key="source.id">{{ source.text }}</div>
    </details>
    <details v-if="sources.length">
      <summary>为新领域补充抽取目标</summary>
      <select v-model="sourceId" class="settings-input" :disabled="busy || working">
        <option value="">选择需要重新提取的原文</option>
        <option v-for="source in sources" :key="source.id" :value="source.sourceId">{{ source.text }}</option>
      </select>
      <input v-model="targets" class="settings-input" placeholder="例如：样品→存放位置；设备→故障" maxlength="2000" />
      <button class="secondary-btn" :disabled="busy || working || !sourceId || !targets.trim()" @click="extract">本地重新提取</button>
    </details>
    <div v-if="message" :class="['api-status-message', { error: failed }]">{{ message }}</div>
  </section>
</template>

<style scoped>
.open-items { max-height: 440px; overflow: auto; }
.memory-review-item { display: block; overflow-wrap: anywhere; }
.memory-review-item > div + div { margin-top: 6px; }
.memory-review-item button { margin-top: 8px; margin-right: 8px; }
input, select { margin-top: 8px; }
</style>
