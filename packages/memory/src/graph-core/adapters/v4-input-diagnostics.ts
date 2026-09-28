import type { MemoryV4Repository } from '../../v4/repository/memory-v4-repository'
import { collectV4RecallInputs } from './v4-recall-input'
import type { V4RecallInputOptions, V4RecallInputRejection } from './v4-recall-input'

export const V4_INPUT_REASONS: Record<V4RecallInputRejection, string> = {
  inactive: '已失效、过期或尚未生效的记录',
  unverified: '尚未验证',
  'unsupported-semantics': '首版不支持的语义或值类型',
  'unknown-time': '缺少有效时间起点',
  'version-mismatch': '与最新事实版本不一致',
  'source-unavailable': '来源不可用、哈希不符或缺少直接证据',
  'access-denied': '当前分享或访问策略不允许',
}

/** Local owner diagnostics only. No source text, fact IDs or other-scope counts leave this boundary. */
export function diagnoseV4GraphInputs(repository: MemoryV4Repository, options: V4RecallInputOptions & {
  authorizeScope: (scope: V4RecallInputOptions['scope']) => boolean
}) {
  if (!options.authorizeScope(structuredClone(options.scope))) throw new Error('Diagnostic scope denied')
  const snapshot = repository.snapshot()
  if (snapshot.facts.length > 10000) throw new Error('Diagnostic scan ceiling exceeded')
  const collected = collectV4RecallInputs(repository, options)
  const counts: Record<V4RecallInputRejection, number> = {
    inactive: 0, unverified: 0, 'unsupported-semantics': 0, 'unknown-time': 0,
    'version-mismatch': 0, 'source-unavailable': 0, 'access-denied': 0,
  }
  for (const item of collected.rejected) counts[item.reason]++
  if (!options.authorizeScope(structuredClone(options.scope))) throw new Error('Diagnostic scope revoked')
  return {
    schema: 'v4-l1-input-diagnostics/v1' as const,
    revision: collected.revision, checkedAt: options.now,
    scopePolicy: 'exact-owner-agent-session' as const,
    inScope: collected.inputs.length + collected.rejected.length,
    eligible: collected.inputs.length, excluded: collected.rejected.length,
    reasons: Object.entries(V4_INPUT_REASONS).map(([reason, label]) => ({ reason, label, count: counts[reason as V4RecallInputRejection] })),
    counting: 'first-failed-check-per-fact' as const,
    interpretation: collected.inputs.length ? 'eligible-inputs-present' as const : 'no-eligible-inputs' as const,
    note: '每条记录只统计第一个未通过项；可接入不等于命中问题，查询时间、关键词和预算仍会影响最终召回。',
  }
}
