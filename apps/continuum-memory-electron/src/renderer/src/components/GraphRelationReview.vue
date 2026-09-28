<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
const props = defineProps<{ disabled?: boolean }>()
const { ipcRenderer } = (window as any).require('electron')
interface Report {
  reviewId: string | null; expiresAt: number | null; canPublish: boolean
  candidateCount: number; observationCount: number; blockers: string[]
  relations: Array<{ id: string; kind: string; fromText: string | null; toText: string | null; eligible: boolean; reasons: string[] }>
}
const report = ref<Report | null>(null), busy = ref(false), message = ref(''), error = ref(false)
const reason = ref(''), confirmed = ref(false), graphEnabled = ref(false), clock = ref(Date.now())
const expired = computed(() => !!report.value?.expiresAt && clock.value >= report.value.expiresAt)
const canConfirm = computed(() => report.value?.canPublish && report.value.reviewId && report.value.relations.length > 0
  && !expired.value && confirmed.value && reason.value.trim().length > 0 && !busy.value && !props.disabled)
const relationNames: Record<string, string> = { causes: '导致', precedes: '发生在……之前', explains: '解释', entails: '蕴含', contradicts: '与……矛盾' }
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { timer = setInterval(() => { clock.value = Date.now() }, 1000) })
onUnmounted(() => { if (timer) clearInterval(timer) })
watch(() => props.disabled, value => { if (value && !busy.value) { report.value = null; confirmed.value = false } })
async function preview() {
  if (busy.value || props.disabled) return
  busy.value = true; report.value = null; reason.value = ''; confirmed.value = false; message.value = ''; error.value = false
  try {
    const result = await ipcRenderer.invoke('memory:graph-review-preview')
    if (!result?.ok) { error.value = true; message.value = result?.error || '无法获取报告。'; return }
    report.value = result.report; graphEnabled.value = result.graphEnabled; clock.value = Date.now()
  } catch { error.value = true; message.value = '无法获取报告，请稍后重试。' }
  finally { busy.value = false }
}
async function publish() {
  if (!canConfirm.value) return
  busy.value = true; message.value = ''; error.value = false
  try {
    const result = await ipcRenderer.invoke('memory:graph-review-confirm', {
      reviewId: report.value!.reviewId, reason: reason.value.trim(), confirmed: confirmed.value,
    })
    error.value = !result?.ok
    message.value = result?.ok
      ? `关系已重新发布。${result.graphEnabled ? '可供图记忆问答使用。' : '当前图问答未启用，本次发布不会开启它。'}`
      : result?.error || '发布未完成，请重新查看报告。'
  } catch { error.value = true; message.value = '发布结果未确认，请重新查看报告。' }
  finally { busy.value = false; report.value = null; confirmed.value = false; reason.value = '' }
}
</script>

<template>
  <section class="relation-review" aria-label="关系复核">
    <div class="review-header">
      <strong>关系复核</strong>
      <button type="button" :disabled="busy || disabled" @click="preview">{{ busy ? '处理中…' : '查看复核报告' }}</button>
    </div>
    <p>检查已有关系是否仍适用于当前记忆。沿用“发送给聊天模型”的权限设置，不会自动创建新关系。</p>
    <p v-if="message" role="status" :class="{ error }">{{ message }}</p>
    <div v-if="report">
      <p v-if="!graphEnabled">当前图问答未启用，复核和发布不会改变该设置。</p>
      <p>已有关系 {{ report.relations.length }} 条；候选 {{ report.candidateCount }} 条；模型观察 {{ report.observationCount }} 条。候选和观察不会自动成为关系。</p>
      <p v-if="!report.relations.length">没有可供复核的已采纳关系。此操作不能从记忆中自动生成关系。</p>
      <ul v-if="report.blockers.length" class="blockers"><li v-for="blocker in report.blockers" :key="blocker">{{ blocker }}</li></ul>
      <div v-if="report.relations.length" class="relation-list">
        <article v-for="(row, i) in report.relations" :key="`${row.id}:${i}`">
          <p>{{ row.fromText || '原事实版本不可用' }} <strong>—{{ relationNames[row.kind] || '关联' }}→</strong> {{ row.toText || '原事实版本不可用' }}</p>
          <span :class="{ error: !row.eligible }">{{ row.eligible ? '端点与来源检查通过，仍需确认关系含义' : '暂不能重新发布' }}</span>
          <ul v-if="row.reasons.length"><li v-for="item in row.reasons" :key="item">{{ item }}</li></ul>
        </article>
      </div>
      <div v-if="report.canPublish && report.relations.length" class="confirmation">
        <p v-if="expired" class="error">报告已过期，请重新查看报告。</p>
        <p v-else>报告有效至 {{ new Date(report.expiresAt!).toLocaleTimeString() }}。发布前会再次检查数据是否变化。</p>
        <label>复核说明<textarea v-model="reason" rows="2" maxlength="2000" :disabled="busy || disabled || expired" placeholder="说明你为什么确认这些关系仍然有效。" /></label>
        <label class="check"><input v-model="confirmed" type="checkbox" :disabled="busy || disabled || expired" />我已查看全部关系，并确认其含义和方向仍然有效。</label>
        <button type="button" :disabled="!canConfirm" @click="publish">确认重新发布</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.relation-review { border: 1px solid var(--border); border-radius: 10px; padding: 12px; margin: 12px 0; font-size: 13px; color: var(--text); }
.review-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
p { line-height: 1.6; margin: 8px 0; }
button { border: 1px solid var(--border); border-radius: 6px; padding: 7px 10px; background: var(--surface); color: var(--text); cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
.relation-list { max-height: 280px; overflow: auto; }
article { border-top: 1px solid var(--border); padding: 8px 0; overflow-wrap: anywhere; }
article strong { color: var(--accent); }
.error, .blockers { color: #e74c3c; }
ul { padding-left: 20px; line-height: 1.6; }
.confirmation { border-top: 1px solid var(--border); margin-top: 10px; padding-top: 8px; }
label { display: block; line-height: 1.6; }
textarea { box-sizing: border-box; display: block; width: 100%; margin: 6px 0; padding: 8px; border: 1px solid var(--border); border-radius: 6px; color: var(--text); background: var(--bg); font: inherit; resize: vertical; }
.check { display: flex; align-items: flex-start; gap: 6px; margin: 10px 0; }
</style>
