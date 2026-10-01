<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ enabled: boolean; memoryEnabled: boolean; remotePolicy: string; busy: boolean }>()
const emit = defineEmits<{ enable: [] }>()
const active = computed(() => props.memoryEnabled && props.enabled && props.remotePolicy !== 'disabled')
</script>

<template>
  <section class="memory-settings-panel" aria-label="原文召回状态">
    <strong>原文关联召回：{{ active ? '已开启，无需逐条审核' : '未启用' }}</strong>
    <p v-if="!memoryEnabled" class="field-hint">长期记忆不可用，当前不能进行原文关联召回。</p>
    <p v-else-if="remotePolicy === 'disabled'" class="field-hint">远程记忆发送已禁用。确认图事实也不会解除这一限制，请在记忆设置中调整发送策略。</p>
    <template v-else-if="!enabled">
      <p class="field-hint">尚未授权将普通历史原文发送给当前 API。这不是图事实审核问题；开启后，获准原文可直接参与关联召回。</p>
      <button class="secondary-btn" :disabled="busy" @click="emit('enable')">授权向当前 API 发送普通历史原文并开启召回</button>
    </template>
    <p v-else class="field-hint">关系只用于寻找已有原文，不生成新事实。实体身份、低模型分数或未发布 Claim 不会单独阻止原文召回；隐私、密钥、拒绝、删除和分享限制仍会排除来源。已开启不代表每条来源都可发送或每次都会命中。</p>
    <p class="field-hint">下面的规范事实确认属于可选管理，不是原文召回的前置步骤；不会自动合并同名实体或把未确认关系当作事实。</p>
  </section>
</template>
