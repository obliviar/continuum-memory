import { describe, expect, it } from 'vitest'
import { extractLocalOpenAssertions } from '../../long-term/open-assertion-extractor'
import type { GraphOpenAssertionRecord } from '../domain/open-assertion-types'
import { assessOpenNavigation, backtraceOpenContext } from './open-assertion-admission'

function sample(text: string): GraphOpenAssertionRecord {
  const extracted = extractLocalOpenAssertions(text), a = extracted.assertions[0]!
  if (!a) throw new Error(`Missing fixture extraction: ${text}`)
  return { ref: { kind: 'open-assertion', id: text, version: 1 }, scope: { ownerId: 'o', agentId: 'a' },
    source: { captureId: 'c', revision: 1, contentHash: 'h' },
    extraction: { sourceId: 's', sourceRevision: 'r', modelId: 'local-open-patterns-v1', runId: 'r', candidateId: a.id },
    relationText: a.relationText, relationSpan: a.relationSpan, evidenceSpan: a.evidenceSpan,
    text: text.slice(a.evidenceSpan.start, a.evidenceSpan.end), context: a.context,
    participants: a.participants.map(p => ({ ...extracted.entities.find(e => e.id === p.mentionId)!,
      ref: { kind: 'mention', id: p.mentionId, version: 1 }, role: p.role, typeCandidate: 'unknown' })),
    attributes: [], review: { status: 'candidate' }, modelScore: a.modelScore, sensitivity: 'normal',
    sharePolicy: 'local-only', inferenceAllowed: false, sourceContext: backtraceOpenContext(text, a.evidenceSpan) }
}

describe('small source-context review comparison', () => {
  it('reduces confirmation requirements on six clear examples while deferring six risky examples', () => {
    const clear = ['样品S7存放在恒温箱B2。', '恒温箱B2发生故障。', '模块A依赖于模块B。',
      '传感器C连接到设备D。', '晶体A与衬底B的关系是外延生长于。', '小王把样品S7放入冷柜C。']
    const risky = ['如果设备修好，样品S7存放在恒温箱B2。', '样品S7不存放在恒温箱B2。',
      '小王说样品S7存放在恒温箱B2。', '他把它放入那里。', '样品S7可能存放在恒温箱B2。',
      '样品S7存放在恒温箱B2？']
    const decisions = [...clear, ...risky].map(text => assessOpenNavigation(sample(text)))
    expect(decisions.filter(d => d.localNavigation === 'automatic')).toHaveLength(6)
    expect(risky.every(text => assessOpenNavigation(sample(text)).localNavigation === 'candidate-only')).toBe(true)
    expect(decisions.every(d => !d.identityMerge && !d.claimPublication && !d.proactiveUse && !d.remoteSharing)).toBe(true)
    console.info('Review comparison: baseline 12/12 confirmations; context navigation 6/12; risky auto approvals 0/6. Designed examples, not production accuracy.')
  })

  it('finds qualifiers outside evidence, keeps unresolved context, and blocks revoked records', () => {
    const record = sample('小王说：\n样品S7存放在恒温箱B2。')
    expect(record.text).not.toContain('小王')
    expect(assessOpenNavigation(record).reasons).toContain('qualified-or-reported-context')
    expect(record.context.speaker.resolution).toBe('unresolved')
    expect(assessOpenNavigation({ ...record, review: { status: 'rejected' } }).localNavigation).toBe('blocked')
  })

  it('defers oversized contexts, low scores, unsupported provenance, and nonliteral relation labels', () => {
    const record = sample('样品S7存放在恒温箱B2。')
    expect(assessOpenNavigation({ ...record, modelScore: 0.8 }).localNavigation).toBe('candidate-only')
    expect(assessOpenNavigation({ ...record, relationSpan: undefined }).localNavigation).toBe('candidate-only')
    expect(assessOpenNavigation({ ...record, extraction: { ...record.extraction, modelId: 'unknown' } }).localNavigation).toBe('candidate-only')
    const source = '前置背景。'.repeat(100) + record.text
    const evidence = { start: source.length - record.text.length, end: source.length }
    const context = backtraceOpenContext(source, evidence)
    expect(context.truncated).toBe(true)
    expect(context.text).toBe(source.slice(context.span.start, context.span.end))
    expect(assessOpenNavigation({ ...record, sourceContext: context, evidenceSpan: evidence }).localNavigation).toBe('candidate-only')
  })
})
