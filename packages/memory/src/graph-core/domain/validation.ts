import { createHash } from 'node:crypto'
import type {
  GraphFactRef,
  GraphScope,
  GraphSourceRef,
  GraphTimeExtent,
  GraphVersionRef,
} from '@continuum-memory/contracts'
import type {


  GraphSemanticRecord,
} from './types'
import type { GraphRecallEdge as GraphEdge, GraphRecallFixtureBundle as GraphSemanticBundle } from './recall-types'

/** Exact source versions supplied by a trusted local reader, not by a model. */
export interface GraphValidationSource {
  readonly episodeId: string
  readonly contentHash: string
  readonly content: string
  readonly scope: GraphScope
}

export interface GraphValidationFactVersion {
  readonly ref: GraphFactRef
  readonly scope: GraphScope
  readonly canonicalText: string
}

export interface GraphRelationValidationInput {
  readonly bundle: GraphSemanticBundle
  readonly edges: readonly GraphEdge[]
  readonly sources: readonly GraphValidationSource[]
  readonly factVersions: readonly GraphValidationFactVersion[]
}

export type GraphRelationValidationCode = 'invalid-reference' | 'duplicate-reference'
  | 'scope-mismatch' | 'missing-claim' | 'missing-relation' | 'missing-context'
  | 'missing-entity' | 'missing-fact-version' | 'invalid-time' | 'missing-source'
  | 'source-hash-mismatch' | 'invalid-source-span' | 'missing-evidence'
  | 'invalid-relation-state' | 'context-mismatch' | 'edge-mismatch' | 'invalid-revision'

export interface GraphRelationValidationIssue {
  readonly code: GraphRelationValidationCode
  readonly path: string
  /** Diagnostics contain field paths, never private source text. */
  readonly message: string
}

export type GraphRelationValidationResult =
  | { readonly ok: true; readonly issues: readonly [] }
  | { readonly ok: false; readonly issues: readonly GraphRelationValidationIssue[] }

/**
 * Consistency checks for the direct Claim/Relation slice of a typed bundle.
 * NOT a JSON/wire validator, authorization check, recall eligibility filter or
 * proof verifier. Rules/statements/other edge families are outside this slice.
 * No data is mutated, no clock is read, and no missing evidence is invented.
 */
export function validateGraphRelations(input: GraphRelationValidationInput): GraphRelationValidationResult {
  const issues: GraphRelationValidationIssue[] = []
  const { bundle } = input
  const issue = (code: GraphRelationValidationCode, path: string, message: string): void => {
    issues.push({ code, path, message })
  }

  function checkRef(ref: GraphVersionRef<string>, kind: string, path: string): void {
    if (ref.kind !== kind || !ref.id.trim() || !Number.isSafeInteger(ref.version) || ref.version < 1)
      issue('invalid-reference', path, 'Reference needs the expected kind, a nonempty ID and a positive integer version')
  }

  function index<T extends { readonly ref: GraphVersionRef<string> }>(items: readonly T[], kind: string, path: string): Map<string, T> {
    const result = new Map<string, T>()
    items.forEach((item, i) => {
      checkRef(item.ref, kind, `${path}[${i}].ref`)
      const key = refKey(item.ref)
      if (result.has(key))
        issue('duplicate-reference', `${path}[${i}].ref`, 'Exact record version occurs more than once')
      result.set(key, item)
    })
    return result
  }

  const claims = index(bundle.claims, 'claim', 'claims')
  const relations = index(bundle.relations, 'relation', 'relations')
  const contexts = index(bundle.contexts, 'context', 'contexts')
  const entities = index(bundle.entities, 'entity', 'entities')
  const facts = index(input.factVersions, 'v4-fact', 'factVersions')
  const sources = new Map<string, GraphValidationSource>()
  input.sources.forEach((source, i) => {
    const path = `sources[${i}]`
    const key = sourceKey(source)
    if (sources.has(key))
      issue('duplicate-reference', path, 'Exact source content version occurs more than once')
    sources.set(key, source)
    if (!source.episodeId.trim() || !/^[a-f0-9]{64}$/.test(source.contentHash)
      || createHash('sha256').update(source.content, 'utf8').digest('hex') !== source.contentHash)
      issue('source-hash-mismatch', path, 'Source hash does not match its exact UTF-8 content')
  })

  function checkScope(container: GraphScope, subject: GraphScope, path: string): void {
    if (!container.ownerId.trim() || !container.agentId.trim()
      || (container.sessionId !== undefined && !container.sessionId.trim())
      || !subject.ownerId.trim() || !subject.agentId.trim()
      || (subject.sessionId !== undefined && !subject.sessionId.trim())
      || container.ownerId !== subject.ownerId || container.agentId !== subject.agentId
      || (container.sessionId !== undefined && container.sessionId !== subject.sessionId))
      issue('scope-mismatch', path, 'Record scope is outside the referenced record or bundle scope')
  }

  function checkTime(time: GraphTimeExtent, path: string): void {
    if (time.kind === 'unknown')
      return
    if (time.kind !== 'interval'
      || (time.from !== null && !Number.isSafeInteger(time.from))
      || (time.to !== null && !Number.isSafeInteger(time.to))
      || (time.from !== null && time.to !== null && time.from >= time.to))
      issue('invalid-time', path, 'Expected an unknown time or a nonempty half-open interval')
  }

  function checkSource(ref: GraphSourceRef, scope: GraphScope, path: string): void {
    const source = sources.get(sourceKey(ref))
    if (!source) {
      issue('missing-source', path, 'Exact source content version is unavailable')
      return
    }
    checkScope(source.scope, scope, path)
    if (ref.locator.kind === 'whole-content')
      return
    const locator = ref.locator
    if (locator.kind !== 'text-span' || locator.unit !== 'utf16'
      || !Number.isSafeInteger(locator.start) || !Number.isSafeInteger(locator.end)
      || locator.start < 0 || locator.end <= locator.start || locator.end > source.content.length
      || splitsSurrogate(source.content, locator.start) || splitsSurrogate(source.content, locator.end))
      issue('invalid-source-span', path, 'Source span must be a nonempty valid UTF-16 range')
  }

  function checkRecord(record: GraphSemanticRecord, path: string): void {
    checkScope(bundle.scope, record.scope, `${path}.scope`)
    const time = record.transactionTime
    if (!Number.isSafeInteger(time.recordedAt)
      || (time.closedAt !== null && (!Number.isSafeInteger(time.closedAt) || time.closedAt < time.recordedAt)))
      issue('invalid-time', `${path}.transactionTime`, 'Invalid transaction-time bounds')
    if (record.provenance.sources.length === 0)
      issue('missing-evidence', `${path}.provenance.sources`, 'Provenance must contain a source')
    record.provenance.sources.forEach((source, i) => checkSource(source, record.scope, `${path}.provenance.sources[${i}]`))
  }

  function checkContext(ref: GraphVersionRef<string>, record: GraphSemanticRecord, path: string): void {
    checkRef(ref, 'context', path)
    const context = contexts.get(refKey(ref))
    if (!context)
      issue('missing-context', path, 'Exact context version is unavailable')
    else
      checkScope(context.scope, record.scope, path)
  }

  checkScope(bundle.scope, bundle.scope, 'bundle.scope')
  if (!Number.isSafeInteger(bundle.revisions.relations) || bundle.revisions.relations < 0)
    issue('invalid-revision', 'bundle.revisions.relations', 'Relation revision must be a nonnegative integer')
  bundle.contexts.forEach((record, i) => {
    checkRecord(record, `contexts[${i}]`)
    if (record.parent)
      checkContext(record.parent, record, `contexts[${i}].parent`)
  })
  bundle.entities.forEach((record, i) => checkRecord(record, `entities[${i}]`))
  bundle.claims.forEach((claim, i) => {
    const path = `claims[${i}]`
    checkRecord(claim, path)
    checkTime(claim.validTime, `${path}.validTime`)
    checkContext(claim.context, claim, `${path}.context`)
    checkRef(claim.fact, 'v4-fact', `${path}.fact`)
    const fact = facts.get(refKey(claim.fact))
    if (!fact)
      issue('missing-fact-version', `${path}.fact`, 'Exact V4 fact version is unavailable')
    else
      checkScope(fact.scope, claim.scope, `${path}.fact`)
    for (const [role, term] of Object.entries(claim.atom.args)) {
      if (term.kind !== 'entity')
        continue
      checkRef(term.ref, 'entity', `${path}.atom.args.${role}`)
      const entity = entities.get(refKey(term.ref))
      if (!entity)
        issue('missing-entity', `${path}.atom.args.${role}`, 'Exact entity version is unavailable')
      else
        checkScope(entity.scope, claim.scope, `${path}.atom.args.${role}`)
    }
    if (claim.evidence.length === 0)
      issue('missing-evidence', `${path}.evidence`, 'Claim must retain evidence references')
    claim.evidence.forEach((entry, j) => checkSource(entry.source, claim.scope, `${path}.evidence[${j}]`))
  })

  bundle.relations.forEach((relation, i) => {
    const path = `relations[${i}]`
    checkRecord(relation, path)
    checkTime(relation.validTime, `${path}.validTime`)
    checkContext(relation.context, relation, `${path}.context`)
    if (!['causal', 'contributes-to', 'before'].includes(relation.kind)
      || !['explicit-claim', 'hypothesis'].includes(relation.assertion)
      || !['active', 'revoked'].includes(relation.status)
      || !['supported', 'refuted', 'conflicted', 'unknown'].includes(relation.support))
      issue('invalid-relation-state', path, 'Unsupported relation kind or state')
    for (const endpoint of ['from', 'to'] as const) {
      checkRef(relation[endpoint], 'claim', `${path}.${endpoint}`)
      const claim = claims.get(refKey(relation[endpoint]))
      if (!claim) {
        issue('missing-claim', `${path}.${endpoint}`, 'Exact endpoint claim version is unavailable')
        continue
      }
      checkScope(claim.scope, relation.scope, `${path}.${endpoint}`)
      // First iteration deliberately accepts only the SAME context version.
      // Context inheritance/bridging requires a future explicit policy.
      if (refKey(claim.context) !== refKey(relation.context))
        issue('context-mismatch', `${path}.${endpoint}`, 'Relation and endpoint must use the same context version')
    }
    // Do NOT require endpoint valid times to overlap: BEFORE (and delayed
    // effects) can correctly connect events at different times.
    if (relation.evidence.length === 0)
      issue('missing-evidence', `${path}.evidence`, 'Relation must retain evidence references')
    relation.evidence.forEach((entry, j) => checkSource(entry.source, relation.scope, `${path}.evidence[${j}]`))
    const roles = new Set(relation.evidence.map(entry => entry.role))
    if ((['supported', 'conflicted'].includes(relation.support) && !roles.has('supports'))
      || (['refuted', 'conflicted'].includes(relation.support) && !roles.has('refutes')))
      issue('missing-evidence', `${path}.support`, 'Declared support state lacks the corresponding evidence role')
  })

  const edgeIds = new Set<string>()
  input.edges.forEach((edge, i) => {
    if (edge.layer !== 'semantic' || !('relationRef' in edge))
      return
    const path = `edges[${i}]`
    if (!edge.id.trim() || edgeIds.has(edge.id))
      issue('duplicate-reference', `${path}.id`, 'Relation edge IDs must be nonempty and unique')
    edgeIds.add(edge.id)
    checkRef(edge.relationRef, 'relation', `${path}.relationRef`)
    const relation = relations.get(refKey(edge.relationRef))
    if (!relation)
      issue('missing-relation', `${path}.relationRef`, 'Exact relation version is unavailable')
    else if (edge.kind !== relation.kind || refKey(edge.from) !== refKey(relation.from)
      || refKey(edge.to) !== refKey(relation.to))
      issue('edge-mismatch', path, 'Projection edge disagrees with relation kind, direction or endpoint version')
  })
  return issues.length > 0 ? { ok: false, issues } : { ok: true, issues: [] }
}

function refKey(ref: GraphVersionRef<string>): string {
  return JSON.stringify([ref.kind, ref.id, ref.version])
}

function sourceKey(source: Pick<GraphSourceRef, 'episodeId' | 'contentHash'>): string {
  return JSON.stringify([source.episodeId, source.contentHash])
}

function splitsSurrogate(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  return before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF
}
