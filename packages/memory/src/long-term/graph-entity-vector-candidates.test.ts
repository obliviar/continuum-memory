import { describe, expect, it } from 'vitest'
import { createGraphExtractionRun } from './graph-extraction-result'
import { graphEntityVectorCandidates } from './graph-entity-vector-candidates'
import { normalizeGraphExtraction } from './graph-identity-normalization'

describe('graph entity vector candidates', () => {
  it('ranks local same-type identities without resolving a mention', () => {
    const scope = { ownerId: 'owner', agentId: 'agent' }
    const run = createGraphExtractionRun({ sourceId: 'source', sourceText: '张三', modelId: 'uie',
      rawOutput: { graph: { entities: [{ id: 'm1', type: 'person', text: '张三',
        span: { start: 0, end: 2 }, modelScore: 0.9 }], facts: [] } } })
    const entities = [
      { ref: { kind: 'entity' as const, id: 'p1', version: 1 }, scope,
        entityType: 'person', canonicalName: '张三', aliases: [], review: { status: 'accepted' } },
      { ref: { kind: 'entity' as const, id: 'other-scope', version: 1 },
        scope: { ownerId: 'other', agentId: 'agent' }, entityType: 'person',
        canonicalName: '张三', aliases: [], review: { status: 'accepted' } },
      { ref: { kind: 'entity' as const, id: 'org', version: 1 }, scope,
        entityType: 'organization', canonicalName: '张三', aliases: [], review: { status: 'accepted' } },
    ]
    const hits = graphEntityVectorCandidates(run, entities, scope)
    expect(hits.m1).toEqual([{ entityId: 'p1', score: expect.closeTo(1) }])
    expect(normalizeGraphExtraction(run, { entities, scope,
      vectorCandidatesByMentionId: hits }).resolutions[0]).toMatchObject({
      status: 'unresolved', candidates: expect.arrayContaining([{ entityId: 'p1', basis: 'vector', score: expect.any(Number) }]),
    })
  })
})
