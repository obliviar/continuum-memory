import { describe, expect, it } from 'vitest'
import type { GraphClaimRecord, GraphPredicateSpec } from '../domain/types'
import type { GraphRelationRecord } from '../domain/relation-types'
import { createGraphRelationTaskQueue, graphRelationPairKey } from './relation-task-queue'

const scope = { ownerId: 'owner', agentId: 'agent' }
const predicate: GraphPredicateSpec = {
  ref: { kind: 'predicate', id: 'worksAt', version: 1 }, name: 'worksAt',
  roles: { person: { type: { entityType: 'person' }, required: true },
    organization: { type: { entityType: 'organization' }, required: true } },
  keyRoles: ['person'], valueRole: 'organization', cardinality: 'multiple',
  symmetry: 'none', transitivity: 'none', inferenceAllowed: false, world: 'open',
}
function claim(id: string, episodeId: string, person: string, sessionId?: string): GraphClaimRecord {
  const source = { episodeId, contentHash: 'hash', locator: { kind: 'text-span' as const,
    unit: 'utf16' as const, start: 0, end: 5 } }
  return {
    ref: { kind: 'claim', id, version: 1 }, fact: { kind: 'v4-fact', id, version: 1 },
    scope: { ...scope, ...(sessionId ? { sessionId } : {}) },
    transactionTime: { recordedAt: Number(id.slice(1)), closedAt: null },
    provenance: { sources: [source], producer: 'extractor', normalizerVersion: 'v1' },
    review: { status: 'accepted', reviewedAt: 1, reviewer: 'user' },
    sensitivity: 'normal', sharePolicy: 'local-only',
    atom: { predicate: 'worksAt', args: { person: { kind: 'entity', ref: { kind: 'entity', id: person, version: 1 } },
      organization: { kind: 'entity', ref: { kind: 'entity', id, version: 1 } } } },
    polarity: 'positive', modality: 'asserted', condition: { kind: 'none' },
    context: { kind: 'context', id: episodeId, version: 1 }, validTime: { kind: 'unknown' },
    evidence: [{ source, role: 'supports', strength: 'direct' }],
  }
}
function storage() {
  let payload: string | undefined
  return { load: () => payload, save: (value: string) => { payload = value } }
}

describe('graph relation judgement queue', () => {
  it('indexes cross-session shared entities and sources, persists once, and pins exact versions and model', () => {
    const persistence = storage()
    const a = claim('c1', 'episode-1', 'person-1', 'session-1')
    const b = claim('c2', 'episode-2', 'person-1', 'session-2')
    const c = claim('c3', 'episode-2', 'person-3', 'session-2')
    const make = (revision: string) => createGraphRelationTaskQueue(persistence,
      { modelId: 'nli', modelRevision: revision, maxDenseSeeds: 0 })
    const queue = make('r1')
    expect(queue.sync([a, b, c], [predicate], scope, () => '')).toBe(2)
    const tasks = queue.snapshot()
    expect(tasks.map(task => task.routes[0])).toEqual(['structured', 'source-cue'])
    const key = graphRelationPairKey(b.ref, a.ref, 'nli', 'r1', 'graph-relation-evidence-v1')
    expect(tasks[0]?.key).toBe(key)
    queue.complete(key, { label: 'NEUTRAL', evaluatedAt: 10 })
    expect(make('r1').sync([a, b, c], [predicate], scope, () => '')).toBe(0)
    expect(make('r1').snapshot().find(task => task.key === key)?.status).toBe('completed')
    expect(make('r2').sync([a, b, c], [predicate], scope, () => '')).toBe(2)
    const revised = { ...b, ref: { ...b.ref, version: 2 } }
    expect(make('r1').sync([a, revised, c], [predicate], scope, () => '')).toBe(2)
    const restored = make('r1')
    expect(restored.snapshot().find(task => task.key === key)?.status).toBe('stale')
    expect(() => restored.complete(key, { label: 'ENTAILMENT', evaluatedAt: 20 })).toThrow('stale')
  })

  it('uses actual vector scores and accepted relation neighbors within a session scope', () => {
    const a = claim('c3', 'source-3', 'p1', 's1')
    const b = claim('c1', 'source-1', 'p2', 's1')
    const c = claim('c2', 'source-2', 'p3', 's1')
    const forbidden = claim('c4', 'source-4', 'p4', 's2')
    const relation = { from: b.ref, to: c.ref, review: { status: 'accepted' },
      transactionTime: { closedAt: null } } as GraphRelationRecord
    const queue = createGraphRelationTaskQueue(storage(), { modelId: 'nli', modelRevision: 'r1', maxDenseSeeds: 1 })
    queue.sync([a, b, c, forbidden], [predicate], { ...scope, sessionId: 's1' },
      item => item.ref.id === 'c3' || item.ref.id === 'c1' ? 'same phrase' : 'different', [relation])
    expect(queue.snapshot().map(task => task.routes[0])).toContain('dense')
    expect(queue.snapshot().some(task => task.routes.includes('relation-neighbor'))).toBe(true)
    expect(queue.snapshot().every(task => task.claims.every(ref => ref.id !== 'c4'))).toBe(true)
  })
})
