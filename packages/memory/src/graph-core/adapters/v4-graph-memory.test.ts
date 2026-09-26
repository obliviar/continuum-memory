import { describe, expect, it } from 'vitest'
import { createV4GraphTestRepository, V4_TEST_SCOPE as scope } from '../fixtures/v4-direct-memory'
import { createV4GraphMemory, V4_GRAPH_BUDGET } from './v4-graph-memory'
import type { MemoryV4Snapshot } from '../../v4/domain/types'
import type { GraphRecallRequest } from '@continuum-memory/contracts'

function setup() {
  const repository = createV4GraphTestRepository()
  let disk: string | undefined
  let allow = true
  const persistence = { load: () => disk, save: (s: string) => { disk = s } }
  const options = { repository, persistence, authorizeScope: (s: typeof scope) => s.ownerId === scope.ownerId && s.agentId === scope.agentId,
    canRead: () => allow, countTokens: (s: string) => Buffer.byteLength(s), now: () => 200 }
  const port = createV4GraphMemory(options)
  const request: GraphRecallRequest = { protocolVersion: 'memory-graph/v1', recallId: 'r', query: 'What do I like?', scope,
    temporal: { knownAt: 200, valid: { kind: 'at', at: 200 } }, mode: 'direct-only', budget: { ...V4_GRAPH_BUDGET },
    sharePolicies: ['local-only'], sensitivities: ['normal'] }
  return { repository, persistence, options, port, request, disk: () => disk, deny: () => { allow = false } }
}

describe('real V4 direct graph memory', () => {
  it('maps verified scalar data, persists an exact L1 snapshot and reloads deterministically', async () => {
    const f = setup()
    const first = await f.port.recall(f.request)
    expect(first).toMatchObject({ ok: true, value: { evidence: { claims: [{ content: 'I like tea', citation: 'G1', polarity: 'positive' }] } } })
    const stored = JSON.parse(f.disk()!)
    expect(stored.projection.semanticBundle.claims[0].fact).toEqual({ kind: 'v4-fact', id: 'f', version: 1 })
    expect(stored.projection.semanticBundle.entities).toEqual([])
    const second = await createV4GraphMemory(f.options).recall({ ...f.request, recallId: 'r2' })
    if (!first.ok || !second.ok) throw new Error('recall failed')
    expect(second.value.manifestId).toBe(first.value.manifestId)
  })
  it('does not revive deleted source text from persisted snapshots', async () => {
    const f = setup()
    await f.port.recall(f.request)
    f.repository.transaction(s => { s.episodes[0]!.contentState = 'deleted'; s.episodes[0]!.deletedAt = 150; delete s.episodes[0]!.content })
    const result = await f.port.recall(f.request)
    expect(result).toMatchObject({ ok: true, value: { evidence: { claims: [] }, trace: { completeness: 'incomplete' } } })
    expect(f.disk()).not.toContain('tea')
  })
  it('rechecks access and does not allow a request to authorize itself', async () => {
    const f = setup()
    await f.port.recall(f.request)
    f.deny()
    expect(await f.port.recall(f.request)).toMatchObject({ ok: true, value: { evidence: { claims: [] } } })
    expect(await f.port.recall({ ...f.request, scope: { ...scope, ownerId: 'other' } })).toMatchObject({ ok: false, error: { code: 'scope-denied' } })
  })
  it('intersects requested sharing policy with source policy', async () => {
    const f = setup()
    expect(await f.port.recall({ ...f.request, sharePolicies: ['allow-remote'] }))
      .toMatchObject({ ok: true, value: { evidence: { claims: [] } } })
  })
  it('rejects proofs, relation questions, historical knownAt and stale manifests', async () => {
    const f = setup()
    for (const override of [{ mode: 'with-proofs' as const }, { query: 'why do I like tea?' },
      { temporal: { ...f.request.temporal, knownAt: 50 } }])
      expect(await f.port.recall({ ...f.request, ...override })).toMatchObject({ ok: false, error: { code: 'unsupported-capability' } })
    expect(await f.port.recall({ ...f.request, expectedManifestId: 'old' })).toMatchObject({ ok: false, error: { code: 'version-mismatch' } })
  })
  it('excludes hash tampering, changed polarity versions and unknown time', async () => {
    for (const mutate of [
      (s: MemoryV4Snapshot) => { s.episodes[0]!.contentHash = 'invalid' },
      (s: MemoryV4Snapshot) => { s.facts[0]!.polarity = 'negative' },
      (s: MemoryV4Snapshot) => { delete s.facts[0]!.validFrom },
    ]) {
      const f = setup(); f.repository.transaction(mutate)
      expect(await f.port.recall(f.request)).toMatchObject({ ok: true, value: { evidence: { claims: [] } } })
    }
  })
  it('honors valid time, evidence and elapsed budgets', async () => {
    const f = setup()
    expect(await f.port.recall({ ...f.request, temporal: { ...f.request.temporal, valid: { kind: 'at', at: 50 } } }))
      .toMatchObject({ ok: true, value: { evidence: { claims: [] } } })
    expect(await f.port.recall({ ...f.request, budget: { ...V4_GRAPH_BUDGET, maxEvidenceTokens: 1 } }))
      .toMatchObject({ ok: true, value: { evidence: { claims: [] }, trace: { stopReason: 'evidence-budget', completeness: 'incomplete' } } })
    expect(await f.port.recall({ ...f.request, budget: { ...V4_GRAPH_BUDGET, maxElapsedMs: 0 } }))
      .toMatchObject({ ok: false, error: { code: 'budget-exhausted' } })
  })
  it('fails closed when publication fails or revokes authorization', async () => {
    const f = setup()
    f.persistence.save = () => { throw new Error('disk') }
    expect(await f.port.recall(f.request)).toMatchObject({ ok: false, error: { code: 'not-ready' } })
    f.persistence.save = () => { f.deny() }
    expect(await f.port.recall(f.request)).toMatchObject({ ok: false, error: { code: 'stale-projection' } })
  })
  it('records bounded idempotent usage receipts, never user corrections without evidence', async () => {
    const f = setup(); const r = await f.port.recall(f.request)
    if (!r.ok) throw new Error('recall failed')
    const report = { protocolVersion: 'memory-graph/v1' as const, feedbackId: 'fb', recallId: 'r', manifestId: r.value.manifestId,
      scope, recordedAt: 200, events: [{ kind: 'cited' as const, target: r.value.evidence.claims[0]!.ref }] }
    expect(await f.port.reportFeedback(report)).toEqual({ ok: true, value: { recorded: true } })
    expect(await f.port.reportFeedback(report)).toEqual({ ok: true, value: { recorded: false } })
    expect(await f.port.reportFeedback({ ...report, events: [] })).toMatchObject({ ok: false })
    f.port.invalidate()
    expect(f.disk()).toBe('{}')
    expect(await f.port.reportFeedback(report)).toMatchObject({ ok: false })
  })
})
