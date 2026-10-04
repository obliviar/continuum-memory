/** Bounded Chinese surface checks for a retrieval target, NOT entailment or relation admission. */
export interface L2TargetState {
  content: string
  outcome?: 'success' | 'failure'
  availability?: 'restored' | 'fault' | 'suspended'
  schedule?: 'cancelled' | 'postponed'
  ambiguous: boolean
}

export function readL2TargetState(text: string): L2TargetState {
  const normalized = text.normalize('NFKC').toLowerCase()
  const state: L2TargetState = { content: normalized, ambiguous: false }
  const set = <K extends 'outcome' | 'availability' | 'schedule'>(key: K, value: NonNullable<L2TargetState[K]>) => {
    if (state[key] && state[key] !== value) state.ambiguous = true
    Object.assign(state, { [key]: value })
  }
  // Only generic outcome/inability cues are removed from lexical anchors. Domain verbs such as
  // cancellation and service suspension retain their original matching behavior.
  state.content = normalized.replace(/没有成功|未能成功|没能成功|未成功|不成功|不能够|无法|不能|未能|没能|失败|成功/g,
    (cue: string) => { set('outcome', cue === '成功' ? 'success' : 'failure'); return ' ' })
  for (const cue of normalized.match(/恢复正常|恢复运行|恢复运营|恢复服务|恢复工作|故障|停用|停运/g) ?? [])
    set('availability', cue.startsWith('恢复') ? 'restored' : cue === '故障' ? 'fault' : 'suspended')
  for (const cue of normalized.match(/取消|停课|停办|叫停|改期|延期|推迟/g) ?? [])
    set('schedule', /改期|延期|推迟/.test(cue) ? 'postponed' : 'cancelled')
  // Do not reinterpret negated/qualified states or multi-clause statements as simple assertions.
  // Exact whole-Claim matches are handled separately by the caller and preserve their original text.
  const recognized = state.outcome || state.availability || state.schedule
  if (recognized && (/没有|并非|不是|尚未|并未|未曾|从未|不曾|不再|未|没|不(?!成功)/.test(state.content)
    || /(?:未|没)(?:恢复|取消|停课|停办|叫停|改期|延期|推迟)/.test(normalized)
    || /如果|假如|假设|可能|也许|据说|听说|计划|预计|准备|打算|[，,；;。.!！?？“”"「」]/.test(normalized.replace(/[。.!！?？]+$/u, ''))))
    state.ambiguous = true
  if (state.outcome === 'failure' && (state.availability === 'restored' || state.schedule)) state.ambiguous = true
  return state
}

/** Missing state confirmation rejects a state-specific query, but is not a factual contradiction. */
export function targetStateCompatible(query: L2TargetState, candidate: L2TargetState): boolean {
  if (!query.outcome && !query.availability && !query.schedule) return true
  if (query.ambiguous || candidate.ambiguous) return false
  for (const key of ['outcome', 'availability', 'schedule'] as const)
    if (query[key] && query[key] !== candidate[key]) return false
  return true
}
