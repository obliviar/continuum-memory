import { createHash } from 'node:crypto'
import type { GraphSourceRef } from '@continuum-memory/contracts'
import { MEMORY_GRAPH_PROTOCOL_VERSION } from '@continuum-memory/contracts'
import type { GraphClaimRecord, GraphLiteral, GraphPredicateSpec, GraphProjectionSnapshot, GraphSemanticRecord } from '../domain/types'
import type { V4RecallInput } from './v4-recall-input'
import type { MemoryV4Scope } from '../../v4/domain/types'

export const V4_SCALAR_MAPPING_POLICY = 'v4-verified-scalar-v1'
export const graphHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const sourceHash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** Mechanical mapping of verified typed V4 fields, no natural-language parsing or entity merges. */
export function projectV4ScalarInputs(inputs: readonly V4RecallInput[], scope: MemoryV4Scope, revision: number): GraphProjectionSnapshot {
  const predicates = new Map<string, GraphPredicateSpec>()
  const contexts = new Map<string, GraphProjectionSnapshot['semanticBundle']['contexts'][number]>()
  const claims: GraphClaimRecord[] = inputs.map(({ fact, version, sources }) => {
    const type = fact.objectType
    if (!(type === 'string' || type === 'number' || type === 'boolean' || type === 'date')
      || (type === 'date' ? typeof fact.normalizedValue !== 'string' || !Number.isFinite(Date.parse(fact.normalizedValue))
        : typeof fact.normalizedValue !== type))
      throw new Error('Unsupported or inconsistent scalar value')
    const value = { kind: type, value: fact.normalizedValue } as GraphLiteral
    const sourceRefs = sources.map(({ episode }): GraphSourceRef => ({ episodeId: episode.id,
      contentHash: sourceHash(episode.content!), locator: { kind: 'whole-content' } }))
    if (!sourceRefs.length || fact.validFrom === undefined) throw new Error('Incomplete V4 mapping input')
    const base: GraphSemanticRecord = {
      scope: fact.scope, transactionTime: { recordedAt: version.recordedAt, closedAt: null },
      provenance: { sources: sourceRefs as [GraphSourceRef, ...GraphSourceRef[]], producer: 'migration',
        normalizerVersion: V4_SCALAR_MAPPING_POLICY },
      review: { status: 'accepted', reviewedAt: fact.updatedAt, reviewer: V4_SCALAR_MAPPING_POLICY },
      sensitivity: [fact, ...sources.map(s => s.episode)].reduce((current, record) =>
        ['normal', 'private', 'secret'].indexOf(record.sensitivity) > ['normal', 'private', 'secret'].indexOf(current)
          ? record.sensitivity : current, fact.sensitivity),
      sharePolicy: [fact, ...sources.map(s => s.episode)].reduce((current, record) =>
        ['allow-remote', 'ask', 'local-only'].indexOf(record.sharePolicy) > ['allow-remote', 'ask', 'local-only'].indexOf(current)
          ? record.sharePolicy : current, fact.sharePolicy),
    }
    // Keep the original subject ID as a literal. No invented entity identity or alias decision.
    const predicate = `v4.scalar.${graphHash([fact.predicate, type, fact.cardinality])}`
    predicates.set(predicate, { ref: { kind: 'predicate', id: predicate, version: 1 }, name: predicate,
      roles: { subject: { type: 'string', required: true }, value: { type, required: true } },
      cardinality: fact.cardinality, keyRoles: ['subject'], valueRole: 'value', symmetry: 'none',
      transitivity: 'none', inferenceAllowed: false, world: 'open' })
    // A source edit or policy tightening without a new V4 fact version must not reuse an exact L1 identity.
    const identity = graphHash([fact.scope, fact.id, version.version, fact.subjectId, fact.predicate,
      fact.normalizedValue, fact.canonicalText, fact.polarity, fact.modality, fact.validFrom, fact.validTo,
      fact.cardinality, sourceRefs, sources.map(s => [s.link.role, s.link.strength]), base.sensitivity, base.sharePolicy])
    const context = { kind: 'context' as const, id: `v4:${identity}`, version: version.version }
    contexts.set(context.id, { ...base, ref: context, domain: 'v4-direct-scalar', scenario: 'actual', parent: null })
    return { ...base, ref: { kind: 'claim', id: `v4:${fact.id}:${identity}`, version: version.version },
      fact: { kind: 'v4-fact', id: fact.id, version: version.version },
      atom: { predicate, args: { subject: { kind: 'string', value: fact.subjectId }, value } },
      polarity: fact.polarity, modality: fact.modality, condition: { kind: 'none' }, context,
      validTime: { kind: 'interval', from: fact.validFrom, to: fact.validTo ?? null },
      evidence: sources.map(({ link }, i) => ({ source: sourceRefs[i]!,
        role: link.role === 'supports' ? 'supports' as const : 'references' as const, strength: link.strength })) as unknown as GraphClaimRecord['evidence'],
    }
  })
  const revisions = { v4: revision, semantics: 1, predicates: 1, rules: 0, aliases: 0 }
  const fingerprint = graphHash([V4_SCALAR_MAPPING_POLICY, scope, revisions, claims, [...predicates.values()]])
  const bundleId = `v4-l1:${fingerprint}`
  return { manifest: { protocolVersion: MEMORY_GRAPH_PROTOCOL_VERSION, schemaVersion: 1,
    manifestId: bundleId, sourceBundleId: bundleId, scope, sourceRevisions: revisions,
    semanticFingerprint: fingerprint, builderVersion: V4_SCALAR_MAPPING_POLICY, navigationRevision: 0,
    createdAt: Math.max(1, ...inputs.map(input => input.fact.updatedAt)), state: 'ready' },
    semanticBundle: { schemaVersion: 1, bundleId, scope, revisions, claims, entities: [], aliases: [],
      predicates: [...predicates.values()], contexts: [...contexts.values()], statements: [], rules: [] },
    edges: [], derivedClaims: [], proofs: [] }
}
