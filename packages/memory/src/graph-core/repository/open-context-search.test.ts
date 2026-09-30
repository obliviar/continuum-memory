import { describe, expect, it, vi } from 'vitest'
import { createCaptureRepository } from '../../long-term/capture-repository'
import { createGraphExtractionResultStore } from '../../long-term/graph-extraction-result'
import { parseUieOutput, uieGraphExtractionRun } from '../../long-term/local-uie'
import { projectOpenAssertions, searchOpenAssertions } from './open-assertions'
import { searchOpenAssertionsWithContext } from './open-context-search'

const scope = { ownerId: 'o', agentId: 'a' }
function records(texts: string[]) {
  const captures = createCaptureRepository({ persistence: { load: () => undefined, save() {} } })
  const extractions = createGraphExtractionResultStore({ load: () => undefined, save() {} })
  texts.forEach((text, i) => {
    const id = String(i)
    captures.register({ userMessage: text, assistantMessage: '', metadata: { sourceMessageIds: [id] } }, scope, 'test')
    extractions.append(uieGraphExtractionRun(id, text, parseUieOutput(text, {})))
  })
  return projectOpenAssertions(captures.snapshot(), extractions, scope)
}

describe('contextual navigation without review permission escalation', () => {
  it('automatically navigates literal records without manufacturing user reviews or Claims', async () => {
    const openAssertions = records(['样品S7存放在恒温箱B2。', '恒温箱B2发生故障。'])
    expect(openAssertions.every(a => a.review.status === 'candidate' && a.admission?.localNavigation === 'automatic')).toBe(true)
    const hits = searchOpenAssertions({ openAssertions }, '样品S7', { scope, maximumDepth: 2 })
    expect(hits).toHaveLength(2)
    expect(hits.every(hit => hit.verification === 'automatic-navigation')).toBe(true)
    expect(new Set(openAssertions.flatMap(a => a.participants.filter(p => p.text === '恒温箱B2').map(p => p.ref.id))).size).toBe(2)
    const result = await searchOpenAssertionsWithContext({ openAssertions }, '样品S7', { scope, maximumDepth: 2 })
    expect(result.semantic.mode).toBe('text-fallback')
    expect(result.items).toEqual(hits)
  })

  it('offers qualified records only with explicit candidate display and retains unknown context', async () => {
    const openAssertions = records(['如果设备修好，样品S7存放在恒温箱B2。'])
    expect(searchOpenAssertions({ openAssertions }, '样品S7', { scope })).toEqual([])
    const result = await searchOpenAssertionsWithContext({ openAssertions }, '样品S7', { scope, includeCandidates: true })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.verification).toBe('unverified-candidate')
    expect(result.items[0]?.assertion.context.condition.resolution).toBe('unresolved')
    expect(result.items[0]?.assertion.sourceContext?.text).toContain('如果')
  })

  it('uses mock contextual vectors to rank and expand semantic seeds, never to accept even maximally similar risky material', async () => {
    const openAssertions = records(['样品S7存放在恒温箱B2。', '恒温箱B2发生故障。', '如果下雨，模块A依赖于模块B。'])
    const embed = vi.fn(async (text: string) => text.includes('存放在') || text === '储存位置' ? [1, 0] : [0, 1])
    const result = await searchOpenAssertionsWithContext({ openAssertions }, '储存位置', { scope, embed, maximumDepth: 2 })
    expect(result.items).toHaveLength(2)
    expect(result.items[0]?.route).toBe('context-vector-candidate')
    expect(result.items[1]?.route).toBe('mention-text-candidate')
    expect(result.items[1]?.via?.contextSimilarity).toBe(0)
    const risky = await searchOpenAssertionsWithContext({ openAssertions }, '如果', {
      scope, embed: async () => [1, 0], includeCandidates: true })
    expect(risky.items.find(hit => hit.assertion.text.includes('如果'))?.verification).toBe('unverified-candidate')
    expect(openAssertions.every(a => a.review.status === 'candidate')).toBe(true)
  })

  it('does not feed foreign, sensitive-excluded or rejected sources into the embedder', async () => {
    const openAssertions = records(['样品S7存放在恒温箱B2。']).map(a => ({ ...a, scope: { ...scope, ownerId: 'other' } }))
    const embed = vi.fn(async () => [1, 0])
    expect((await searchOpenAssertionsWithContext({ openAssertions }, '样品', { scope, embed, includeCandidates: true })).items).toEqual([])
    expect(embed).toHaveBeenCalledTimes(1) // Query only; no foreign context was supplied.
    const own = records(['样品S7存放在恒温箱B2。'])
    const rejected = own.map(a => ({ ...a, review: { status: 'rejected' as const } }))
    expect((await searchOpenAssertionsWithContext({ openAssertions: rejected }, '样品', { scope, embed, includeCandidates: true })).items).toEqual([])
    expect((await searchOpenAssertionsWithContext({ openAssertions: own }, '样品', { scope, embed, sensitivities: [] })).items).toEqual([])
  })

  it('degrades safely on model failure and malformed vectors and enforces the query vector budget', async () => {
    const openAssertions = records(['样品S7存放在恒温箱B2。', '恒温箱B2发生故障。'])
    for (const embed of [async () => { throw new Error('offline') }, async () => [NaN], async () => [0, 0]]) {
      const result = await searchOpenAssertionsWithContext({ openAssertions }, '样品S7', { scope, embed })
      expect(result.semantic.mode).toBe('text-fallback')
      expect(result.items).toHaveLength(2)
    }
    const embed = vi.fn(async () => [1, 0])
    const result = await searchOpenAssertionsWithContext({ openAssertions }, '样品S7', { scope, embed, vectorBudget: 1, limit: 1 })
    expect(embed).toHaveBeenCalledTimes(2)
    expect(result.items).toHaveLength(1)
    expect(result.semantic.truncated).toBe(true)
  })

  it('does not traverse identical names with incompatible explicit type proposals', () => {
    const original = records(['苹果存放在水果库。', '苹果与芯片的关系是制造。'])
    const openAssertions = original.map(a => ({ ...a, participants: a.participants.map(p => p.text === '苹果'
      ? { ...p, typeCandidate: a.relationText === '存放在' ? 'fruit' : 'company' } : p) }))
    const result = searchOpenAssertions({ openAssertions }, '水果库', { scope, maximumDepth: 2 })
    expect(result).toHaveLength(1)
    expect(result[0]?.assertion.text).toContain('水果库')
  })
})
