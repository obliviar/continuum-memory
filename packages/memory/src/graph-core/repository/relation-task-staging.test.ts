import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { GraphClaimRecord, GraphProjectionSnapshot } from '../domain/types'
import type { GraphRelationJudgementTask } from './relation-task-queue'
import { createGraphRelationRepository } from './relation-repository'
import { stageGraphRelationTasks } from './relation-task-staging'
import { graphRelationPairKey } from './relation-task-queue'
import { publishReviewedGraphRelation } from './relation-admission'
import { rebaseGraphRelations } from './relation-rebase'
import { projectGraphRelationEdges } from '../domain/relation-core'

const now = 1_800_000_000_000
const scope = { ownerId: 'owner', agentId: 'agent' }
const context = { kind: 'context' as const, id: 'actual', version: 1 }
const source = { episodeId: 'episode', contentHash: 'hash', locator: { kind: 'text-span' as const,
  unit: 'utf16' as const, start: 0, end: 8 } }
function claim(id: string): GraphClaimRecord {
  return { ref: { kind: 'claim', id, version: 1 }, fact: { kind: 'v4-fact', id, version: 1 }, scope,
    transactionTime: { recordedAt: now, closedAt: null },
    provenance: { sources: [source], producer: 'extractor', normalizerVersion: 'test' },
    review: { status: 'accepted', reviewedAt: now, reviewer: 'test' },
    sensitivity: 'normal', sharePolicy: 'local-only', atom: { predicate: id, args: {} },
    polarity: 'positive', modality: 'asserted', condition: { kind: 'none' }, context,
    validTime: { kind: 'interval', from: now - 1, to: now + 86_400_000 },
    evidence: [{ source, role: 'supports', strength: 'direct' }] }
}
function core(): GraphProjectionSnapshot {
  const revisions = { v4: 1, semantics: 1, predicates: 1, rules: 0, aliases: 0 }
  return { manifest: { protocolVersion: 'memory-graph/v1', schemaVersion: 1,
    manifestId: 'core-1', sourceBundleId: 'bundle-1', scope, sourceRevisions: revisions,
    semanticFingerprint: 'fingerprint', builderVersion: 'test', navigationRevision: 0,
    createdAt: now, state: 'ready' },
  semanticBundle: { schemaVersion: 1, bundleId: 'bundle-1', scope, revisions,
    entities: [], aliases: [], predicates: [], contexts: [{ ref: context, scope,
      transactionTime: { recordedAt: now, closedAt: null },
      provenance: { sources: [source], producer: 'extractor', normalizerVersion: 'test' },
      review: { status: 'accepted', reviewedAt: now, reviewer: 'test' }, sensitivity: 'normal',
      sharePolicy: 'local-only', domain: 'test', scenario: 'actual', parent: null }],
    claims: [claim('a'), claim('b')], statements: [], rules: [] },
  derivedClaims: [], proofs: [], edges: [] }
}
function hash(text: string): string { return createHash('sha256').update(text).digest('hex') }
function evidenceText(record: GraphClaimRecord): string { return `${record.ref.id} evidence` }
function task(label: 'CONTRADICTION' | 'NEUTRAL' | 'ENTAILMENT'): GraphRelationJudgementTask {
  const scores = label === 'ENTAILMENT' ? { CONTRADICTION: 0.05, NEUTRAL: 0.05, ENTAILMENT: 0.9 }
    : label === 'CONTRADICTION' ? { CONTRADICTION: 0.9, NEUTRAL: 0.05, ENTAILMENT: 0.05 }
      : { CONTRADICTION: 0.05, NEUTRAL: 0.9, ENTAILMENT: 0.05 }
  const claims = [{ kind: 'claim' as const, id: 'b', version: 1 },
    { kind: 'claim' as const, id: 'a', version: 1 }] as const
  return { key: graphRelationPairKey(claims[0], claims[1], 'nli', `weights-${label}`, 'pair-v1'),
    claims, modelId: 'nli', modelRevision: `weights-${label}`,
  preprocessingVersion: 'pair-v1', routes: ['dense'], status: 'completed', createdAt: now,
  result: { label, scores, premiseHash: hash('b evidence'), hypothesisHash: hash('a evidence'),
    truncated: false, evaluatedAt: now + 1 } }
}

describe('NLI task to L2 candidate staging', () => {
  it('stages entailment and canonical contradiction without making authoritative edges', async () => {
    const projection = core()
    const repository = createGraphRelationRepository({ coreSnapshot: () => projection,
      now: () => now, verifySources: async () => ({ ok: true, value: undefined }) })
    const input = { repository, core: projection, tasks: [task('ENTAILMENT'), task('CONTRADICTION'), task('NEUTRAL')],
      evidenceText: (record: GraphClaimRecord) => `${record.ref.id} evidence`, now: () => now + 2 }
    const first = await stageGraphRelationTasks(input)
    expect(first).toMatchObject({ ok: true, value: { stagedCandidates: 2, stagedObservations: 2,
      skipped: { 'neutral-is-not-a-relation': 1 } } })
    expect(repository.snapshot().candidates).toMatchObject([
      { kind: 'entails', from: { id: 'b' }, to: { id: 'a' }, resolution: { status: 'pending' } },
      { kind: 'contradicts', from: { id: 'a' }, to: { id: 'b' }, resolution: { status: 'pending' } },
    ])
    expect(repository.snapshot().manifest).toMatchObject({ relationRevision: 0, candidateRevision: 1 })
    expect(projectGraphRelationEdges(repository.snapshot())).toEqual([])
    expect(await stageGraphRelationTasks(input)).toMatchObject({ ok: true,
      value: { stagedCandidates: 0, stagedObservations: 0 } })
  })

  it('rejects stale text/context and fails closed when source verification denies publication', async () => {
    const projection = core()
    const repository = createGraphRelationRepository({ coreSnapshot: () => projection,
      now: () => now, verifySources: async () => ({ ok: false,
        error: { code: 'source-unavailable', message: 'deleted' } }) })
    const base = { repository, core: projection, tasks: [task('ENTAILMENT')], now: () => now + 2 }
    const stale = await stageGraphRelationTasks({ ...base, evidenceText: () => 'changed' })
    expect(stale).toMatchObject({ ok: true, value: { stagedCandidates: 0,
      skipped: { 'evidence-hash-changed': 1 } } })
    const denied = await stageGraphRelationTasks({ ...base,
      evidenceText: (record: GraphClaimRecord) => `${record.ref.id} evidence` })
    expect(denied).toMatchObject({ ok: false, error: { code: 'source-unavailable' } })
    expect(repository.snapshot().candidates).toHaveLength(0)
    const altered = { ...projection, semanticBundle: { ...projection.semanticBundle,
      claims: [projection.semanticBundle.claims[0]!,
        { ...projection.semanticBundle.claims[1]!, context: { ...context, id: 'other' } }] } }
    const invalid = await stageGraphRelationTasks({ ...base, core: altered,
      evidenceText: (record: GraphClaimRecord) => `${record.ref.id} evidence` })
    expect(invalid).toMatchObject({ ok: true, value: { stagedCandidates: 0 } })
  })

  it('requires a separate explicit decision before a staged suggestion becomes an L2 relation', async () => {
    const projection = core()
    const repository = createGraphRelationRepository({ coreSnapshot: () => projection,
      now: () => now, verifySources: async () => ({ ok: true, value: undefined }) })
    const selected = task('ENTAILMENT')
    expect(await stageGraphRelationTasks({ repository, core: projection, tasks: [selected],
      evidenceText: (record: GraphClaimRecord) => `${record.ref.id} evidence`, now: () => now + 1 }))
      .toMatchObject({ ok: true })
    expect(repository.snapshot().relations).toHaveLength(0)
    const candidateId = repository.snapshot().candidates[0]!.id
    expect(await publishReviewedGraphRelation({ repository, core: projection, candidateId, evidenceText,
      reviewer: 'local-user', reason: '', now: () => now + 2 }))
      .toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(await publishReviewedGraphRelation({ repository, core: projection, candidateId,
      evidenceText: () => 'changed after NLI', reviewer: 'local-user',
      reason: 'Reviewed', now: () => now + 2 }))
      .toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    const published = await publishReviewedGraphRelation({ repository, core: projection, candidateId, evidenceText,
      reviewer: 'local-user', reason: 'I compared the two exact source statements', now: () => now + 2 })
    expect(published).toMatchObject({ ok: true })
    expect(repository.snapshot().relations).toMatchObject([{ kind: 'entails',
      assertionBasis: 'user-confirmed', reviewReason: 'I compared the two exact source statements',
      nliObservationIds: [repository.snapshot().observations[0]!.id] }])
    expect(projectGraphRelationEdges(repository.snapshot())).toHaveLength(1)
    expect(await publishReviewedGraphRelation({ repository, core: projection, candidateId, evidenceText,
      reviewer: 'local-user', reason: 'I compared the two exact source statements', now: () => now + 2 }))
      .toMatchObject({ ok: true, value: { manifestId: repository.snapshot().manifest.manifestId } })
  })

  it('keeps a changed L1 view unreadable until exact references are purged and rebound', async () => {
    let projection = core()
    let payload: string | undefined
    const persistence = { load: () => payload, save: (next: string) => { payload = next } }
    const options = { coreSnapshot: () => projection, persistence,
      now: () => now, verifySources: async () => ({ ok: true as const, value: undefined }) }
    const repository = createGraphRelationRepository(options)
    expect(await stageGraphRelationTasks({ repository, core: projection, tasks: [task('ENTAILMENT')],
      evidenceText: (record: GraphClaimRecord) => `${record.ref.id} evidence`, now: () => now + 1 }))
      .toMatchObject({ ok: true })
    const candidateId = repository.snapshot().candidates[0]!.id
    expect(await publishReviewedGraphRelation({ repository, core: projection, candidateId, evidenceText,
      reason: 'Confirmed by user', reviewer: 'local-user', now: () => now + 2 }))
      .toMatchObject({ ok: true })
    projection = { ...projection, manifest: { ...projection.manifest, manifestId: 'core-2' } }
    const restarted = createGraphRelationRepository(options)
    expect(restarted.snapshot().manifest.state).toBe('stale')
    expect(projectGraphRelationEdges(restarted.snapshot())).toEqual([])
    expect(await rebaseGraphRelations({ repository: restarted, core: projection, now: () => now + 3 }))
      .toMatchObject({ ok: true, value: { purgedClaims: 0 } })
    expect(projectGraphRelationEdges(restarted.snapshot())).toHaveLength(1)
    projection = { ...projection, manifest: { ...projection.manifest, manifestId: 'core-3' },
      semanticBundle: { ...projection.semanticBundle,
        claims: projection.semanticBundle.claims.filter(item => item.ref.id !== 'a') } }
    expect(await rebaseGraphRelations({ repository: restarted, core: projection, now: () => now + 4 }))
      .toMatchObject({ ok: true, value: { purgedClaims: 1 } })
    expect(restarted.snapshot()).toMatchObject({ relations: [], candidates: [], observations: [] })
    expect(projectGraphRelationEdges(restarted.snapshot())).toEqual([])
  })

  it('does not treat an omitted truncation flag as untruncated model evidence', async () => {
    const projection = core()
    const repository = createGraphRelationRepository({ coreSnapshot: () => projection,
      now: () => now, verifySources: async () => ({ ok: true, value: undefined }) })
    const complete = task('ENTAILMENT')
    const partial = { ...complete, result: { ...complete.result!, truncated: undefined } }
    expect(await stageGraphRelationTasks({ repository, core: projection, tasks: [partial],
      evidenceText: (record: GraphClaimRecord) => `${record.ref.id} evidence` }))
      .toMatchObject({ ok: true, value: { stagedCandidates: 0,
        skipped: { 'incomplete-nli-observation': 1 } } })
  })

  it('keeps truncated and rejected NLI candidates out of the authoritative relation set', async () => {
    const projection = core()
    const repository = createGraphRelationRepository({ coreSnapshot: () => projection,
      now: () => now, verifySources: async () => ({ ok: true, value: undefined }) })
    const truncated = task('ENTAILMENT')
    const rejected = { ...task('CONTRADICTION'), review: { status: 'rejected' as const,
      reason: 'The texts do not actually contradict', reviewedAt: now + 1,
      reviewer: 'local-user' as const } }
    expect(await stageGraphRelationTasks({ repository, core: projection,
      tasks: [{ ...truncated, result: { ...truncated.result!, truncated: true } }, rejected],
      evidenceText: (record: GraphClaimRecord) => `${record.ref.id} evidence`, now: () => now + 2 }))
      .toMatchObject({ ok: true, value: { stagedCandidates: 2 } })
    const candidates = repository.snapshot().candidates
    expect(await publishReviewedGraphRelation({ repository, core: projection, evidenceText,
      candidateId: candidates[0]!.id, reviewer: 'local-user', reason: 'Reviewed', now: () => now + 3 }))
      .toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(await publishReviewedGraphRelation({ repository, core: projection, evidenceText,
      candidateId: candidates[1]!.id, reviewer: 'local-user', reason: 'Reviewed', now: () => now + 3 }))
      .toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(repository.snapshot().relations).toEqual([])
  })
})
