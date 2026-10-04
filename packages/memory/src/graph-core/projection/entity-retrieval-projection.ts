import type { GraphClaimRecord, GraphEntityRecord } from '../domain/types'
import { graphHash } from '../adapters/v4-semantic-adapter'

export const ENTITY_RETRIEVAL_TEXT_POLICY = 'entity-claim-fragments-v1'
export type EntityRetrievalTextMode = 'name-only' | 'claim-fragments'
export interface EntityRetrievalEntry {
  readonly claim: GraphClaimRecord
  readonly fact: { readonly id: string; readonly canonicalText: string }
}
export interface EntityRetrievalDocument {
  readonly id: string
  readonly canonicalText: string
  readonly entityRef: GraphEntityRecord['ref']
  readonly kind: 'name' | 'claim-fragment'
  readonly claimRef?: GraphClaimRecord['ref']
  readonly factRef?: GraphClaimRecord['fact']
  readonly sources: GraphClaimRecord['provenance']['sources']
  readonly entitySources: GraphEntityRecord['provenance']['sources']
  /** Offset in canonical Fact text, not an original-source citation span. */
  readonly textSpan?: { readonly field: 'fact.canonicalText'; readonly start: number; readonly end: number; readonly unit: 'utf16' }
}

// Fixed versioned limits; changing them changes the projection policy, not a request parameter.
const NAME_CHARS = 256, FRAGMENT_CHARS = 384, CLAIM_PARTS = 4, ENTITY_PARTS = 32
function endAt(text: string, start: number, size: number) {
  let end = Math.min(text.length, start + size)
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '') && /[\uDC00-\uDFFF]/.test(text[end] ?? '')) end--
  return end
}

/** Stable legacy name document, retained for the name-only control and old caches. */
export const entityVectorDocument = (entity: GraphEntityRecord) => ({
  id: `graph-entity:${graphHash([entity.scope, entity.ref, entity.provenance])}`,
  canonicalText: [entity.canonicalName, ...entity.aliases, entity.entityType].join('\n'),
})

/** Derived navigation only. Caller supplies retained, source-verified entries, never raw/open assertions. */
export function buildEntityRetrievalProjection(input: {
  entities: readonly GraphEntityRecord[]
  entries: readonly EntityRetrievalEntry[]
  mode: EntityRetrievalTextMode
}) {
  if (!['name-only', 'claim-fragments'].includes(input.mode)) throw new Error('Invalid entity retrieval text mode')
  const byEntity = new Map<string, EntityRetrievalEntry[]>()
  for (const entry of input.entries) {
    const claim = entry.claim
    if (claim.review.status !== 'accepted' || claim.transactionTime.closedAt !== null || claim.fact.id !== entry.fact.id) continue
    for (const key of new Set(Object.values(claim.atom.args).flatMap(t => t.kind === 'entity' ? [graphHash(t.ref)] : []))) {
      const list = byEntity.get(key) ?? []; list.push(entry); byEntity.set(key, list)
    }
  }
  const documents: EntityRetrievalDocument[] = []
  let omittedFragments = 0, truncatedClaims = 0
  for (const entity of input.entities) {
    if (entity.review.status !== 'accepted' || entity.transactionTime.closedAt !== null) continue
    const name = entityVectorDocument(entity)
    documents.push({ ...name, entityRef: entity.ref, kind: 'name', sources: entity.provenance.sources,
      entitySources: entity.provenance.sources })
    if (input.mode === 'name-only') continue
    const prefix = name.canonicalText.slice(0, endAt(name.canonicalText, 0, NAME_CHARS))
    const entries = (byEntity.get(graphHash(entity.ref)) ?? [])
      .filter(e => graphHash(e.claim.scope) === graphHash(entity.scope))
      .sort((a, b) => b.claim.transactionTime.recordedAt - a.claim.transactionTime.recordedAt
        || graphHash(a.claim.ref).localeCompare(graphHash(b.claim.ref)))
    const fragments: EntityRetrievalDocument[][] = []
    const seen = new Set<string>()
    for (const { claim, fact } of entries) {
      const key = graphHash(claim.ref)
      if (seen.has(key)) continue
      seen.add(key)
      const parts: EntityRetrievalDocument[] = []
      const fingerprint = graphHash([ENTITY_RETRIEVAL_TEXT_POLICY, entity, claim,
        { id: fact.id, canonicalText: fact.canonicalText }])
      let start = 0
      while (start < fact.canonicalText.length && parts.length < CLAIM_PARTS) {
        const end = endAt(fact.canonicalText, start, FRAGMENT_CHARS)
        const span = { field: 'fact.canonicalText' as const, start, end, unit: 'utf16' as const }
        const canonicalText = `${prefix}\n${fact.canonicalText.slice(start, end)}`
        // Full record fingerprints bind review, scope, permissions, source versions and fact text.
        const id = `graph-entity-fragment:${graphHash([fingerprint, span])}`
        parts.push({ id, canonicalText, entityRef: entity.ref, claimRef: claim.ref, factRef: claim.fact,
          kind: 'claim-fragment', sources: claim.provenance.sources, entitySources: entity.provenance.sources, textSpan: span })
        start = end
      }
      if (start < fact.canonicalText.length) truncatedClaims++
      fragments.push(parts)
    }
    // Give each Claim a first fragment before adding second fragments of long Claims.
    let kept = 0
    for (let part = 0; part < CLAIM_PARTS; part++) for (const list of fragments) {
      const document = list[part]; if (!document) continue
      if (kept < ENTITY_PARTS) { documents.push(document); kept++ } else omittedFragments++
    }
  }
  return { documents, omittedFragments, truncatedClaims,
    incomplete: omittedFragments > 0 || truncatedClaims > 0 }
}
