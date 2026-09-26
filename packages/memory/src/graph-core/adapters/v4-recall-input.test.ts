import { describe, expect, it } from 'vitest'
import { createMemoryV4Repository } from '../../v4/repository/memory-v4-repository'
import type { MemoryV4Snapshot } from '../../v4/domain/types'
import { collectV4RecallInputs } from './v4-recall-input'

const scope = { ownerId: 'owner', agentId: 'agent' }
function fixture() {
  const repo = createMemoryV4Repository({ now: () => 100 })
  repo.transaction(draft => {
    draft.episodes.push({ id: 'ep', scope, actor: 'user', kind: 'message', contentState: 'available',
      content: 'I like tea', recordedAt: 100, sourceAttachmentIds: [], sensitivity: 'normal',
      sharePolicy: 'local-only', provenance: 'native-v4' })
    draft.evidenceLinks.push({ id: 'ev', factId: 'f', episodeId: 'ep', role: 'supports',
      strength: 'direct', active: true, createdAt: 100 })
    const fields = { subjectId: 'owner', predicate: 'likes', object: 'tea', objectType: 'string' as const,
      normalizedValue: 'tea', canonicalText: 'I like tea', polarity: 'positive' as const,
      modality: 'asserted' as const, status: 'active' as const, validFrom: 100, evidenceLinkIds: ['ev'] }
    draft.facts.push({ ...fields, id: 'f', scope, memoryKey: 'likes', cardinality: 'multiple',
      recordedAt: 100, updatedAt: 100, extractionScore: 1, verificationScore: 1, evidenceScore: 1,
      utilityScore: 1, importance: 1, accessCount: 0, userConfirmed: true, verificationState: 'verified',
      supersedesFactIds: [], conflictsWithFactIds: [], sensitivity: 'normal', sharePolicy: 'local-only',
      origin: 'manual', extractorVersion: 'test', verifierVersion: 'test' })
    draft.factVersions.push({ ...fields, id: 'v1', factId: 'f', version: 1, operation: 'ADD',
      recordedAt: 100, reason: 'test' })
  })
  return repo
}
function collect(repo: ReturnType<typeof fixture>, extra = {}) {
  return collectV4RecallInputs(repo, { scope, expectedRevision: repo.snapshot().revision,
    now: 200, canRead: () => true, ...extra })
}

describe('V4 recall input staging', () => {
  it('returns exact versions and sources without accepting graph semantics or mutating V4', () => {
    const repo = fixture()
    const before = repo.snapshot()
    const result = collect(repo)
    expect(result.requiresSemanticReview).toBe(true)
    expect(result.inputs[0]?.version.id).toBe('v1')
    expect(result.inputs[0]?.sources[0]?.episode.content).toBe('I like tea')
    result.inputs[0]!.fact.canonicalText = 'changed'
    expect(repo.snapshot()).toEqual(before)
  })
  it('isolates owner, agent and session, including omission of rejection IDs', () => {
    for (const other of [{ ...scope, ownerId: 'other' }, { ...scope, agentId: 'other' }, { ...scope, sessionId: 's' }]) {
      expect(collect(fixture(), { scope: other })).toMatchObject({ inputs: [], rejected: [] })
    }
  })
  it.each([
    ['unverified', (s: MemoryV4Snapshot) => { s.facts[0]!.verificationState = 'legacy-unverified' }],
    ['inactive', (s: MemoryV4Snapshot) => { s.facts[0]!.expiresAt = 150 }],
    ['unknown-time', (s: MemoryV4Snapshot) => { delete s.facts[0]!.validFrom }],
    ['unsupported-semantics', (s: MemoryV4Snapshot) => { s.facts[0]!.condition = 'if sunny' }],
    ['unsupported-semantics', (s: MemoryV4Snapshot) => { s.facts[0]!.modality = 'hypothetical' }],
    ['version-mismatch', (s: MemoryV4Snapshot) => { s.facts[0]!.polarity = 'negative' }],
    ['source-unavailable', (s: MemoryV4Snapshot) => { s.episodes[0]!.contentState = 'unavailable'; delete s.episodes[0]!.content }],
    ['source-unavailable', (s: MemoryV4Snapshot) => { s.evidenceLinks[0]!.strength = 'reference-only' }],
  ] as const)('excludes %s records', (reason, change) => {
    const repo = fixture()
    repo.transaction(change)
    expect(collect(repo)).toMatchObject({ inputs: [], rejected: [{ factId: 'f', reason }] })
  })
  it('requires separate authorization for facts and source episodes', () => {
    for (const deniedId of ['f', 'ep'])
      expect(collect(fixture(), { canRead: (r: { id: string }) => r.id !== deniedId }))
        .toMatchObject({ inputs: [], rejected: [{ reason: 'access-denied' }] })
  })
  it('rejects stale revisions and concurrent policy-triggered updates', () => {
    const repo = fixture()
    expect(() => collect(repo, { expectedRevision: 0 })).toThrow('revision changed')
    expect(() => collect(repo, { canRead: () => { repo.transaction(() => {}); return true } }))
      .toThrow('changed during collection')
  })
  it('does not allow a policy callback to rewrite the staged source', () => {
    const result = collect(fixture(), { canRead: (r: { id: string }) => { r.id = 'forged'; return true } })
    expect(result.inputs[0]?.fact.id).toBe('f')
    expect(result.inputs[0]?.sources[0]?.episode.id).toBe('ep')
  })
})
