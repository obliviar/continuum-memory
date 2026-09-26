import { createHash } from 'node:crypto'
import type { GraphSourceRef, GraphTimeExtent } from '@continuum-memory/contracts'
import type { GraphClaimRecord,  GraphSemanticRecord } from '../domain/types'
import type { GraphRecallRelationRecord as GraphRelationRecord } from '../domain/recall-types'
import type { GraphRelationValidationInput, GraphValidationSource } from '../domain/validation'

export const FEVER_ABSENCE_DAY = Date.parse('2026-09-20T00:00:00+08:00')
export const FEVER_ABSENCE_RECORDED_AT = Date.parse('2026-09-21T09:00:00+08:00')
export const FEVER_ABSENCE_REVOKED_AT = Date.parse('2026-09-22T09:00:00+08:00')
const DAY = 24 * 60 * 60 * 1000

/**
 * Synthetic, manually reviewed fixture; never written to the user's memories.
 * Each call returns independent data. No API calls, current clock or embeddings.
 * C1 --R1/causal--> C2; C3 is a different-day distractor.
 */
export function createFeverAbsenceFixture(includeRevocation = false): GraphRelationValidationInput {
  const scope = { ownerId: 'fixture-owner', agentId: 'fixture-agent' }
  const context = { kind: 'context', id: 'actual-work', version: 1 } as const
  const person = { kind: 'entity', id: 'zhang-san', version: 1 } as const
  const validTime: GraphTimeExtent = { kind: 'interval', from: FEVER_ABSENCE_DAY, to: FEVER_ABSENCE_DAY + DAY }
  const sources: GraphValidationSource[] = []

  function source(episodeId: string, content: string): GraphSourceRef {
    const contentHash = createHash('sha256').update(content, 'utf8').digest('hex')
    sources.push({ episodeId, contentHash, content, scope: { ...scope } })
    return {
      episodeId, contentHash,
      locator: { kind: 'text-span', unit: 'utf16', start: 0, end: content.length },
    }
  }

  const original = source('E1', '张三在2026年9月20日因为发烧，所以没有去上班。')
  const distractor = source('E2', '张三在2026年9月10日休假，没有去上班。')

  function base(evidence: GraphSourceRef, recordedAt = FEVER_ABSENCE_RECORDED_AT): GraphSemanticRecord {
    return {
      scope: { ...scope },
      transactionTime: { recordedAt, closedAt: null },
      provenance: { sources: [evidence], producer: 'user', normalizerVersion: 'fixture-v1' },
      review: { status: 'accepted', reviewedAt: recordedAt, reviewer: 'fixture-author' },
      sensitivity: 'normal',
      sharePolicy: 'allow-remote',
    }
  }

  const claims: GraphClaimRecord[] = [
    {
      ...base(original),
      ref: { kind: 'claim', id: 'C1', version: 1 },
      fact: { kind: 'v4-fact', id: 'F1', version: 1 },
      atom: { predicate: 'person.hasSymptom', args: {
        person: { kind: 'entity', ref: person },
        symptom: { kind: 'string', value: 'fever' },
        day: { kind: 'date', value: '2026-09-20' },
      } },
      polarity: 'positive', modality: 'asserted', condition: { kind: 'none' },
      context, validTime,
      evidence: [{ source: original, role: 'supports', strength: 'direct' }],
    },
    {
      ...base(original),
      ref: { kind: 'claim', id: 'C2', version: 1 },
      fact: { kind: 'v4-fact', id: 'F2', version: 1 },
      atom: { predicate: 'person.attendedWork', args: {
        person: { kind: 'entity', ref: person },
        day: { kind: 'date', value: '2026-09-20' },
      } },
      polarity: 'negative', modality: 'asserted', condition: { kind: 'none' },
      context, validTime,
      evidence: [{ source: original, role: 'supports', strength: 'direct' }],
    },
    {
      ...base(distractor),
      ref: { kind: 'claim', id: 'C3', version: 1 },
      fact: { kind: 'v4-fact', id: 'F3', version: 1 },
      atom: { predicate: 'person.attendedWork', args: {
        person: { kind: 'entity', ref: person },
        day: { kind: 'date', value: '2026-09-10' },
      } },
      polarity: 'negative', modality: 'asserted', condition: { kind: 'none' },
      context, validTime: { kind: 'interval', from: FEVER_ABSENCE_DAY - 10 * DAY, to: FEVER_ABSENCE_DAY - 9 * DAY },
      evidence: [{ source: distractor, role: 'supports', strength: 'direct' }],
    },
  ]

  const relation: GraphRelationRecord = {
    ...base(original),
    ref: { kind: 'relation', id: 'R1', version: 1 },
    from: claims[0]!.ref, to: claims[1]!.ref, kind: 'causal', context, validTime,
    assertion: 'explicit-claim', status: 'active', support: 'supported',
    evidence: [{ source: original, role: 'supports' }],
  }
  const relations: GraphRelationRecord[] = [relation]
  if (includeRevocation) {
    const correction = source('E3', '更正：张三2026年9月20日是休息日，撤回此前将未上班归因于发烧的说法。')
    // Preserve the original decision instead of overwriting its historical state.
    relations[0] = { ...relation, transactionTime: {
      recordedAt: FEVER_ABSENCE_RECORDED_AT, closedAt: FEVER_ABSENCE_REVOKED_AT,
    } }
    relations.push({
      ...relation, ...base(correction, FEVER_ABSENCE_REVOKED_AT),
      ref: { kind: 'relation', id: 'R1', version: 2 },
      status: 'revoked', support: 'refuted',
      evidence: [{ source: correction, role: 'refutes' }],
    })
  }

  const result: GraphRelationValidationInput = {
    bundle: {
      schemaVersion: 1, bundleId: includeRevocation ? 'fixture-bundle-2' : 'fixture-bundle-1', scope,
      revisions: { v4: 1, semantics: 1, predicates: 1, rules: 0, aliases: 0, relations: includeRevocation ? 2 : 1 },
      entities: [{ ...base(original), ref: person, entityType: 'person', canonicalName: '张三', aliases: [] }],
      aliases: [],
      predicates: ['person.hasSymptom', 'person.attendedWork'].map(name => ({
        ref: { kind: 'predicate' as const, id: name, version: 1 }, name,
        roles: {
          person: { type: { entityType: 'person' }, required: true },
          day: { type: 'date' as const, required: true },
          ...(name === 'person.hasSymptom' ? { symptom: { type: 'string' as const, required: true } } : {}),
        },
        cardinality: 'multiple' as const, keyRoles: ['person', 'day'], valueRole: null,
        symmetry: 'none' as const, transitivity: 'none' as const, inferenceAllowed: false, world: 'open' as const,
      })),
      contexts: [{ ...base(original), ref: context, domain: 'work', scenario: 'actual', parent: null }],
      claims, relations, statements: [], rules: [],
    },
    // Historical edges may be retained for auditing. Query eligibility is a
    // separate step and must NOT be inferred from successful validation.
    edges: relations.map(item => ({
      id: `edge-R1-v${item.ref.version}`, layer: 'semantic', kind: item.kind,
      from: item.from, to: item.to, relationRef: item.ref,
    })),
    sources,
    factVersions: claims.map((claim, i) => ({
      ref: claim.fact, scope,
      canonicalText: ['张三2026年9月20日发烧。', '张三2026年9月20日没有上班。', '张三2026年9月10日没有上班。'][i]!,
    })),
  }
  // References inside one record must not accidentally alias other records
  // when a test edits a version or scope.
  return JSON.parse(JSON.stringify(result)) as GraphRelationValidationInput
}
