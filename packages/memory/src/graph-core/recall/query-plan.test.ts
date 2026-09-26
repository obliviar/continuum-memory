import { describe, expect, it } from 'vitest'
import type { GraphResult } from '@continuum-memory/contracts'
import { planGraphQuery } from './query-plan'
import type { GraphQueryPlanInput } from './query-plan'

const temporal = { valid: { kind: 'at' as const, at: 123 }, knownAt: 456 }
function plan(query: string, options: Partial<GraphQueryPlanInput> = {}) {
  return value(planGraphQuery({ query, temporal, ...options }))
}
function value<T>(result: GraphResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

describe('unified graph question planning', () => {
  it.each([
    ['张三为什么没有上班？', 'cause', '张三 没有上班', 'in', ['causal', 'contributes-to'], 'cause'],
    ['什么导致了发烧？', 'cause', '发烧', 'in', ['causal', 'contributes-to'], 'cause'],
    ['缺勤的原因是什么？', 'cause', '缺勤', 'in', ['causal', 'contributes-to'], 'cause'],
    ['张三发烧造成了什么影响？', 'effect', '张三发烧', 'out', ['causal', 'contributes-to'], 'effect'],
    ['发烧有什么后果？', 'effect', '发烧', 'out', ['causal', 'contributes-to'], 'effect'],
    ['缺勤之前发生了什么？', 'before', '缺勤', 'in', ['before'], 'earlier-event'],
    ['发烧之后发生了什么？', 'after', '发烧', 'out', ['before'], 'later-event'],
    ['What happened before fever?', 'before', 'fever', 'in', ['before'], 'earlier-event'],
    ['What happened after fever?', 'after', 'fever', 'out', ['before'], 'later-event'],
    ['What are the effects of fever?', 'effect', 'fever', 'out', ['causal', 'contributes-to'], 'effect'],
    ['与发烧相关的记忆？', 'related', '发烧', 'both', ['causal', 'contributes-to', 'before'], 'related-claim'],
  ])('plans %s', (query, type, target, direction, kinds, missing) => {
    const result = plan(query as string)
    expect(result).toMatchObject({ status: 'ready', questionType: type, target: { text: target, resolution: 'candidate-needed' },
      traversal: { direction, kinds, source: 'question' }, missingInformation: missing })
    expect(result.requiredEvidence).toEqual(['target-claim', 'linked-claim', 'relation-record', 'source-spans'])
    expect(result.followUpChecks).toEqual(['competing-explanations', 'conflicts'])
  })

  it('does not invent an entity ID from a named person in the question', () => {
    expect(plan('李明为什么缺勤？').target).toMatchObject({ entities: [], entityResolution: 'not-resolved', text: '李明 缺勤' })
  })

  it.each([
    ['他为什么没有上班？', 'unresolved-pronoun'],
    ['Why did she miss work?', 'unresolved-pronoun'],
    ['为什么？', 'target-event'],
    ['张三的记忆', 'question-type'],
    ['为什么缺勤，之后发生了什么？', 'competing-intents'],
  ])('preserves uncertainty for %s', (query, reason) => {
    const result = plan(query)
    expect(result.status).toBe('needs-clarification')
    expect(result.traversal).toBeNull()
    expect(result.clarificationReasons).toContain(reason)
  })

  it('uses host identity and target constraints without mutating them', () => {
    const entities = [{ kind: 'entity' as const, id: 'person-1', version: 2 }]
    const result = plan('他为什么没有上班？', { constraints: { entities, targetText: '没有上班' } })
    expect(result.status).toBe('ready')
    expect(result.target).toMatchObject({ entities, entityResolution: 'host-resolved', text: '没有上班' })
    Object.assign(entities[0]!, { id: 'changed' })
    expect(result.target.entities[0]!.id).toBe('person-1')
  })

  it('records explicit traversal as custom, rather than calling it an inferred causal search', () => {
    const result = plan('张三为什么没上班？', { direction: 'out', kinds: ['before'] })
    expect(result).toMatchObject({ questionType: 'custom', missingInformation: 'related-claim',
      traversal: { direction: 'out', kinds: ['before'], source: 'caller' } })
  })

  it('supports an explicit host question type for otherwise unsupported wording', () => {
    const result = plan('没来是咋回事', { constraints: { questionType: 'cause', targetText: '没有上班' } })
    expect(result).toMatchObject({ status: 'ready', questionType: 'cause', searchQuery: '没有上班',
      traversal: { direction: 'in', source: 'caller' } })
  })

  it('does not use a partial override to guess the missing relation semantics', () => {
    expect(plan('张三的记忆', { direction: 'out' }).status).toBe('needs-clarification')
  })

  it('composes the existing time planner and preserves the knowledge clock', () => {
    const result = plan('张三昨天为什么没有上班？', {
      timePlanning: { referenceTime: Date.parse('2026-09-21T09:00:00+08:00'), utcOffsetMinutes: 480 },
    })
    expect(result.target.text).toBe('张三 没有上班')
    expect(result.temporal).toEqual({ knownAt: 456, valid: { kind: 'overlap',
      from: Date.parse('2026-09-20T00:00:00+08:00'), to: Date.parse('2026-09-21T00:00:00+08:00') } })
  })

  it('rejects invalid exact entity references', () => {
    expect(planGraphQuery({ query: '张三为什么缺勤', temporal,
      constraints: { entities: [{ kind: 'entity', id: '张三', version: 0 }] } })).toMatchObject({ ok: false })
  })
})
