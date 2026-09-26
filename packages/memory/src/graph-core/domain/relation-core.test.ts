import { describe, expect, it } from 'vitest'
import type { GraphSourceRef } from '@continuum-memory/contracts'
import { assertGraphRelationSnapshot, projectGraphRelationEdges } from './relation-core'
import { selectGraphRelationPairSeeds } from './relation-candidates'
import type { GraphNliObservation, GraphRelationCandidate, GraphRelationRecord, GraphRelationSnapshot } from './relation-types'
import type { GraphClaimRecord, GraphProjectionSnapshot } from './types'
import { createGraphRelationRepository } from '../repository/relation-repository'
import { createGraphRelationReadPort } from '../repository/relation-read-port'
import type { GraphReadView } from '../ports/graph-ports'

const NOW = 1_800_000_000_000
const scope = { ownerId: 'owner', agentId: 'agent' } as const
const source: GraphSourceRef = {
  episodeId: 'episode-1', contentHash: 'content-1',
  locator: { kind: 'text-span', unit: 'utf16', start: 0, end: 12 },
}
const context = { kind: 'context', id: 'actual', version: 1 } as const
const fromRef = { kind: 'claim', id: 'rain', version: 1 } as const
const toRef = { kind: 'claim', id: 'flight-cancelled', version: 1 } as const
const relationRef = { kind: 'relation', id: 'rain-causes-cancellation', version: 1 } as const

function claim(ref: typeof fromRef | typeof toRef): GraphClaimRecord {
  return {
    ref, fact: { kind: 'v4-fact', id: ref.id, version: 1 },
    scope, transactionTime: { recordedAt: NOW, closedAt: null },
    provenance: { sources: [source], producer: 'extractor', normalizerVersion: 'n1' },
    review: { status: 'accepted', reviewedAt: NOW, reviewer: 'test' },
    sensitivity: 'normal', sharePolicy: 'local-only',
    atom: { predicate: ref.id, args: {} }, polarity: 'positive', modality: 'asserted',
    condition: { kind: 'none' }, context, validTime: { kind: 'unknown' },
    evidence: [{ source, role: 'supports', strength: 'direct' }],
  }
}

function core(): GraphProjectionSnapshot {
  const revisions = { v4: 1, semantics: 1, predicates: 1, rules: 1, aliases: 1 }
  return {
    manifest: {
      protocolVersion: 'memory-graph/v1', schemaVersion: 1, manifestId: 'core-1',
      sourceBundleId: 'bundle-1', scope, sourceRevisions: revisions,
      semanticFingerprint: 'fingerprint', builderVersion: 'test', navigationRevision: 1,
      createdAt: NOW, state: 'ready',
    },
    semanticBundle: {
      schemaVersion: 1, bundleId: 'bundle-1', scope, revisions,
      entities: [], aliases: [], predicates: [],
      contexts: [{
        ref: context, scope, transactionTime: { recordedAt: NOW, closedAt: null },
        provenance: { sources: [source], producer: 'extractor', normalizerVersion: 'n1' },
        review: { status: 'accepted', reviewedAt: NOW, reviewer: 'test' },
        sensitivity: 'normal', sharePolicy: 'local-only', domain: 'test', scenario: 'actual', parent: null,
      }],
      claims: [claim(fromRef), claim(toRef)], statements: [], rules: [],
    },
    derivedClaims: [], proofs: [], edges: [],
  }
}

function candidate(): GraphRelationCandidate {
  return {
    id: 'candidate-1', scope, from: fromRef, to: toRef, kind: 'causes',
    context, validTime: { kind: 'unknown' }, sourceHints: [source],
    hypothesisText: '暴雨导致航班取消',
    generator: { route: 'source-cue', version: 'cue-v1' }, resolution: { status: 'pending' },
  }
}

function observation(): GraphNliObservation {
  return {
    id: 'nli-1', candidateId: 'candidate-1', premise: { kind: 'source', ref: source },
    premiseHash: 'premise-hash', hypothesisHash: 'hypothesis-hash',
    scores: { CONTRADICTION: 0.01, NEUTRAL: 0.03, ENTAILMENT: 0.96 },
    predicted: 'ENTAILMENT', modelId: 'Erlangshen-Roberta-330M-NLI',
    modelRevision: 'weights-1', preprocessingVersion: 'pair-v1', truncated: false,
    evaluatedAt: NOW,
  }
}

function relation(): GraphRelationRecord {
  return {
    ref: relationRef, from: fromRef, to: toRef, kind: 'causes',
    polarity: 'positive', modality: 'asserted', context, validTime: { kind: 'unknown' },
    assertionBasis: 'source-explicit', evidence: [{ source, role: 'supports' }],
    candidateId: 'candidate-1', nliObservationIds: ['nli-1'],
    scope, transactionTime: { recordedAt: NOW + 1, closedAt: null },
    provenance: { sources: [source], producer: 'extractor', normalizerVersion: 'n1' },
    review: { status: 'accepted', reviewedAt: NOW + 1, reviewer: 'test' },
    sensitivity: 'normal', sharePolicy: 'local-only',
  }
}

function snapshot(): GraphRelationSnapshot {
  return {
    manifest: {
      protocolVersion: 'memory-graph/v1', schemaVersion: 1, manifestId: 'relations-1',
      scope, coreManifestId: 'core-1', sourceBundleId: 'bundle-1',
      relationRevision: 1, candidateRevision: 1, createdAt: NOW + 1, state: 'ready',
    },
    candidates: [{ ...candidate(), resolution: { status: 'accepted', relation: relationRef } }],
    observations: [observation()], relations: [relation()],
  }
}

describe('L2 relation layer', () => {
  it('uses dense seeds and accepted one-hop neighbors without treating either as a relation', () => {
    const rain = claim(fromRef)
    const flight = claim(toRef)
    const neighbor: GraphClaimRecord = {
      ...flight,
      ref: { kind: 'claim', id: 'airport-closed', version: 1 },
    }
    const otherOwner: GraphClaimRecord = {
      ...flight, scope: { ownerId: 'another-owner', agentId: 'agent' },
      ref: { kind: 'claim', id: 'inaccessible', version: 1 },
    }
    const seeds = selectGraphRelationPairSeeds({
      source: rain, sourceCue: [], structured: [], dense: [flight, rain],
      neighbors: [
        { seed: toRef, related: neighbor },
        { seed: toRef, related: otherOwner },
      ],
      maxCandidates: 2, maxDenseSeeds: 1,
    })
    expect(seeds).toEqual([
      { from: fromRef, to: toRef, route: 'dense' },
      { from: fromRef, to: neighbor.ref, route: 'relation-neighbor' },
    ])
  })

  it('keeps NLI candidates outside authoritative graph edges', () => {
    const staged: GraphRelationSnapshot = {
      ...snapshot(), relations: [], candidates: [candidate()],
      manifest: { ...snapshot().manifest, relationRevision: 0 },
    }
    expect(() => assertGraphRelationSnapshot(staged, core())).not.toThrow()
    expect(projectGraphRelationEdges(staged)).toEqual([])
    expect(projectGraphRelationEdges(snapshot())).toEqual([expect.objectContaining({
      relation: relationRef, relationKind: 'causes', from: fromRef, to: toRef,
    })])
  })

  it('rejects stale endpoints, mismatched context, weaker policy and truncated model evidence', () => {
    const base = snapshot()
    expect(() => assertGraphRelationSnapshot(base, core())).not.toThrow()
    const wrongVersion = { ...base, relations: [{ ...relation(), to: { ...toRef, version: 2 } }] }
    expect(() => assertGraphRelationSnapshot(wrongVersion, core())).toThrow('exact L1 claim version')
    const wrongContext = { ...base, relations: [{ ...relation(), context: { ...context, id: 'other' } }] }
    expect(() => assertGraphRelationSnapshot(wrongContext, core())).toThrow('exact L1 context version')
    const unmodified = core()
    const restrictedCore: GraphProjectionSnapshot = {
      ...unmodified,
      semanticBundle: {
        ...unmodified.semanticBundle,
        claims: [{ ...unmodified.semanticBundle.claims[0]!, sensitivity: 'secret' }, unmodified.semanticBundle.claims[1]!],
      },
    }
    expect(() => assertGraphRelationSnapshot(base, restrictedCore)).toThrow('weakens endpoint sensitivity')
    const truncated = { ...base, observations: [{ ...observation(), truncated: true }] }
    expect(() => assertGraphRelationSnapshot(truncated, core())).toThrow('truncated NLI observation')
  })

  it('rejects noncanonical contradiction and disjoint logical time', () => {
    const base = snapshot()
    const contradiction: GraphRelationRecord = {
      ...relation(), kind: 'contradicts',
    }
    expect(() => assertGraphRelationSnapshot({ ...base, relations: [contradiction] }, core())).toThrow('canonicalized')
    const original = core()
    const disjointCore: GraphProjectionSnapshot = {
      ...original,
      semanticBundle: {
        ...original.semanticBundle,
        claims: [
          { ...original.semanticBundle.claims[0]!, validTime: { kind: 'interval', from: 0, to: 10 } },
          { ...original.semanticBundle.claims[1]!, validTime: { kind: 'interval', from: 20, to: 30 } },
        ],
      },
    }
    const entailment = { ...relation(), kind: 'entails' as const }
    expect(() => assertGraphRelationSnapshot({ ...base, relations: [entailment] }, disjointCore)).toThrow('disjoint endpoint times')
  })

  it('publishes with CAS, verifies sources, and preserves previous state on persistence failure', async () => {
    const c = core()
    let payload: string | undefined
    let failSave = false
    const repository = createGraphRelationRepository({
      coreSnapshot: () => c,
      now: () => NOW,
      persistence: {
        load: () => payload,
        save: next => { if (failSave) throw new Error('disk failed'); payload = next },
      },
      verifySources: async refs => refs.length === 1
        ? { ok: true, value: undefined }
        : { ok: false, error: { code: 'source-unavailable', message: 'Wrong source count' } },
    })
    const initial = repository.snapshot().manifest.manifestId
    const published = await repository.publish({ operationId: 'op-1', expectedManifestId: initial, snapshot: snapshot() })
    expect(published).toEqual({ ok: true, value: { manifestId: 'relations-1', relationRevision: 1 } })
    expect(repository.snapshot().relations).toHaveLength(1)
    const retry = await repository.publish({ operationId: 'op-1', expectedManifestId: initial, snapshot: snapshot() })
    expect(retry).toMatchObject({ ok: false, error: { code: 'version-mismatch' } })

    const base = snapshot()
    const next: GraphRelationSnapshot = {
      ...base,
      manifest: { ...base.manifest, manifestId: 'relations-2', relationRevision: 2 },
      relations: [{ ...relation(), transactionTime: { recordedAt: NOW + 1, closedAt: NOW + 2 } }],
    }
    failSave = true
    await expect(repository.publish({ operationId: 'op-2', expectedManifestId: 'relations-1', snapshot: next })).rejects.toThrow('disk failed')
    expect(repository.snapshot().manifest.manifestId).toBe('relations-1')
    expect(repository.snapshot().relations[0]!.transactionTime.closedAt).toBeNull()
  })

  it('does not advance the authoritative revision for candidate-only work', async () => {
    const repository = createGraphRelationRepository({
      coreSnapshot: core, now: () => NOW,
      verifySources: async () => ({ ok: true, value: undefined }),
    })
    const initial = repository.snapshot()
    const staged: GraphRelationSnapshot = {
      ...initial,
      manifest: {
        ...initial.manifest,
        manifestId: 'candidate-only-1', candidateRevision: 1, createdAt: NOW + 1,
      },
      candidates: [candidate()], observations: [observation()],
    }
    expect((await repository.publish({
      operationId: 'stage-1', expectedManifestId: initial.manifest.manifestId, snapshot: staged,
    })).ok).toBe(true)
    expect(repository.snapshot().manifest.relationRevision).toBe(0)
    expect(projectGraphRelationEdges(repository.snapshot())).toEqual([])
  })

  it('fails closed when the trusted host cannot verify sources', async () => {
    const repository = createGraphRelationRepository({
      coreSnapshot: core, now: () => NOW,
      verifySources: async () => ({ ok: false, error: { code: 'source-unavailable', message: 'Deleted source' } }),
    })
    const initial = repository.snapshot().manifest.manifestId
    const result = await repository.publish({ operationId: 'op-1', expectedManifestId: initial, snapshot: snapshot() })
    expect(result).toMatchObject({ ok: false, error: { code: 'source-unavailable' } })
    expect(repository.snapshot().manifest.manifestId).toBe(initial)
  })

  it('prevents rewriting accepted history in a later publication', async () => {
    const repository = createGraphRelationRepository({
      coreSnapshot: core, now: () => NOW,
      verifySources: async () => ({ ok: true, value: undefined }),
    })
    const initial = repository.snapshot().manifest.manifestId
    expect((await repository.publish({ operationId: 'op-1', expectedManifestId: initial, snapshot: snapshot() })).ok).toBe(true)
    const old = snapshot()
    const rewritten: GraphRelationSnapshot = {
      ...old,
      manifest: { ...old.manifest, manifestId: 'relations-2', relationRevision: 2 },
      relations: [{ ...relation(), polarity: 'negative' }],
    }
    const result = await repository.publish({ operationId: 'op-2', expectedManifestId: 'relations-1', snapshot: rewritten })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-request', message: 'Existing relation version was rewritten' } })
  })

  it('invalidates relation reads before a core rebuild', async () => {
    const repository = createGraphRelationRepository({
      coreSnapshot: core, now: () => NOW + 2,
      verifySources: async () => ({ ok: true, value: undefined }),
    })
    const initial = repository.snapshot().manifest.manifestId
    const invalidated = await repository.invalidate({
      operationId: 'invalidate-1', scope, expectedManifestId: initial,
      nextManifestId: 'relation-stale-1', reason: 'source-changed',
    })
    expect(invalidated.ok).toBe(true)
    expect(repository.snapshot().manifest.state).toBe('stale')
    expect(projectGraphRelationEdges(repository.snapshot())).toEqual([])
  })

  it('purges exact source-backed relations, candidates and observations together', async () => {
    let payload: string | undefined
    const repository = createGraphRelationRepository({
      coreSnapshot: core, now: () => NOW,
      persistence: { load: () => payload, save: next => { payload = next } },
      verifySources: async () => ({ ok: true, value: undefined }),
    })
    const initial = repository.snapshot().manifest.manifestId
    expect((await repository.publish({ operationId: 'op-1', expectedManifestId: initial, snapshot: snapshot() })).ok).toBe(true)
    const result = await repository.purge({
      operationId: 'purge-1', scope, expectedManifestId: 'relations-1', nextManifestId: 'relations-purged-1',
      sourceVersions: [source], claimVersions: [],
    })
    expect(result).toEqual({ ok: true, value: {
      removedRelations: 1, removedCandidates: 1, removedObservations: 1,
    } })
    expect(repository.snapshot().manifest).toMatchObject({ state: 'stale', relationRevision: 2, candidateRevision: 2 })
    expect(repository.snapshot().relations).toEqual([])
    expect(payload).not.toContain('rain-causes-cancellation')
    expect(projectGraphRelationEdges(repository.snapshot())).toEqual([])
  })

  it('reads authorized exact relations and bounded neighbors through a pinned L1 view', async () => {
    const c = core()
    const repository = createGraphRelationRepository({
      coreSnapshot: () => c, now: () => NOW,
      verifySources: async () => ({ ok: true, value: undefined }),
    })
    const initial = repository.snapshot().manifest.manifestId
    expect((await repository.publish({ operationId: 'op-1', expectedManifestId: initial, snapshot: snapshot() })).ok).toBe(true)
    let coreLive = true
    let sourceChecks = 0
    const readPort = createGraphRelationReadPort({
      repository,
      isCoreViewLive: async () => coreLive,
      verifySources: async refs => {
        sourceChecks += 1
        return refs.length === 1
          ? { ok: true, value: undefined }
          : { ok: false, error: { code: 'source-unavailable', message: 'Source missing' } }
      },
    })
    const coreView: GraphReadView = {
      viewId: 'core-view-1', manifest: c.manifest,
      context: {
        access: {
          accessContextId: 'access-1', authorizationVersion: 'auth-1', scope,
          sharePolicies: ['local-only'], sensitivities: ['normal'],
        },
        expectedManifestId: 'core-1', policyVersion: 'policy-1',
        temporal: { valid: { kind: 'at', at: NOW }, knownAt: NOW + 2 },
        budget: {
          maxSeeds: 10, maxNodes: 10, maxEdges: 1, maxHops: 1,
          maxRuleBindings: 1, maxProofSteps: 1, maxElapsedMs: 1000, maxEvidenceTokens: 100,
        },
      },
      resolveClaims: async () => ({ ok: true, value: [] }),
      resolveStatements: async () => ({ ok: true, value: [] }),
      resolveRules: async () => ({ ok: true, value: [] }),
      neighbors: async () => ({ ok: true, value: { items: [], scanned: 0, completion: 'complete' } }),
      matchRuleBody: async () => ({ ok: true, value: { items: [], scanned: 0, completion: 'complete' } }),
      findConflicts: async () => ({ ok: true, value: { items: [], scanned: 0, completion: 'complete' } }),
      close: async () => {},
    }
    const opened = await readPort.openView({ coreView, expectedRelationManifestId: 'relations-1' })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    const resolved = await opened.value.resolveRelations([relationRef])
    expect(resolved.ok && resolved.value).toHaveLength(1)
    const neighbors = await opened.value.neighbors({
      claim: fromRef, direction: 'out', kinds: ['causes'], limit: 10, maxScanned: 10,
    })
    expect(neighbors.ok && neighbors.value.items).toEqual([expect.objectContaining({
      relation: relationRef, polarity: 'positive', modality: 'asserted',
    })])
    expect(await opened.value.neighbors({
      claim: fromRef, direction: 'out', kinds: ['causes'], limit: 10, maxScanned: 10,
      cursor: 'forged.cursor',
    })).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(sourceChecks).toBe(2)
    coreLive = false
    expect(await opened.value.resolveRelations([relationRef])).toMatchObject({ ok: false, error: { code: 'view-closed' } })
  })
})
