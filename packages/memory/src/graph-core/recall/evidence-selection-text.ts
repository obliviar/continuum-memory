import type { GraphClaimRecord, GraphEntityRecord, GraphPredicateSpec } from '../domain/types'
import { graphHash } from '../adapters/v4-semantic-adapter'

/** Index once, then inspect only the exact subject of each retained candidate. */
export function createEvidenceSelectionText(input: {
  query: string; entities: readonly GraphEntityRecord[]; knownAt: number
  sharePolicies: readonly string[]; sensitivities: readonly string[]
  canReadEntity: (entity: GraphEntityRecord) => boolean
}) {
  const entities = new Map(input.entities.map(entity => [graphHash(entity.ref), entity]))
  return (claim: GraphClaimRecord, canonicalText: string): string => {
    const subject = claim.atom.args.subject
    const entity = subject?.kind === 'entity' ? entities.get(graphHash(subject.ref)) : undefined
    const readable = entity && graphHash(entity.scope) === graphHash(claim.scope)
      && entity.review.status === 'accepted' && entity.review.reviewedAt <= input.knownAt
      && entity.transactionTime.recordedAt <= input.knownAt && entity.transactionTime.closedAt === null
      && input.sharePolicies.includes(entity.sharePolicy) && input.sensitivities.includes(entity.sensitivity)
      && input.canReadEntity(entity)
    return evidenceSelectionText({ query: input.query, claim, canonicalText, entities: readable ? [entity] : [] })
  }
}

/** A scoring view only. Citations and the delivered fact always retain their original text.
 * The caller supplies exact-version, source-checked entities; aliases never establish identity.
 */
export function evidenceSelectionText(input: {
  query: string; canonicalText: string; claim: GraphClaimRecord
  entities: readonly GraphEntityRecord[]
}): string {
  const { claim } = input
  let text = input.canonicalText
  const subject = claim.atom.args.subject
  const entity = subject?.kind === 'entity' ? input.entities.find(e =>
    e.ref.id === subject.ref.id && e.ref.version === subject.ref.version) : undefined
  // Preserve the original wording for negated questions, reported/conditional statements
  // and unknown polarity. A name rewrite must not weaken these semantic distinctions.
  if (entity && claim.modality === 'asserted' && claim.condition.kind === 'none' && claim.polarity !== 'unknown'
    && !/不|没|未|无|非|\b(?:not|no|never|without)\b|n't\b/i.test(input.query)) {
    // Substitute only the leading subject, never names inside objects, quotations or other roles.
    // Match the query's explicit reviewed alias; do not equate every "用户" with "我".
    const names = [...new Set([entity.canonicalName, ...entity.aliases])].filter(Boolean)
      .sort((a, b) => b.length - a.length)
    const prefix = names.find(name => text.startsWith(name)
      && (!/[a-z0-9_]$/i.test(name) || !/[a-z0-9_]/i.test(text[name.length] ?? '')))
    const query = input.query.normalize('NFKC').trim()
    const alias = names.find(name => query.startsWith(name)
      && (name !== '我' || !query.startsWith('我们'))
      && (name.length > 1 || name === '我' || query === name)
      && (!/[a-z0-9_]$/i.test(name) || !/[a-z0-9_]/i.test(query[name.length] ?? '')))
    if (prefix && alias && prefix !== alias) text = alias + text.slice(prefix.length)
  }
  // Enrich compressed statements from accepted structure without inventing predicate synonyms.
  const relation = claim.sourceStatement?.relationText
  if (relation && !text.includes(relation)) text += `\n关系：${relation}`
  for (const [role, term] of Object.entries(claim.atom.args)) {
    // Legacy scalar subjects can be opaque owner IDs, not names for the scorer.
    if (term.kind === 'entity' || role === 'subject') continue
    const value = String(term.value)
    if (value && !text.includes(value)) text += `\n${role}：${value}`
  }
  // Never flatten a conditional, reported or uncertain statement into an asserted fact.
  if (claim.condition.kind !== 'none') text += `\n条件：${claim.condition.text}`
  if (claim.modality !== 'asserted') text += `\n陈述方式：${claim.modality}`
  if (claim.polarity === 'unknown') text += '\n肯定或否定尚不明确'
  return text
}

/** Same answer slot, not just a semantic neighbour. Grouping never creates new candidates.
 * Every retained value must pass its own absolute relevance threshold.
 */
export function evidenceSelectionGroup(claim: GraphClaimRecord, predicate: GraphPredicateSpec | undefined): string | undefined {
  const valueRole = predicate?.valueRole
  if (!predicate || predicate.name !== claim.atom.predicate || !valueRole || !claim.atom.args[valueRole]
    || !predicate.roles[valueRole] || claim.polarity === 'unknown') return undefined
  const bindings = Object.fromEntries(Object.entries(claim.atom.args).filter(([role]) => role !== valueRole)
    .sort(([a], [b]) => a.localeCompare(b)))
  if (!Object.keys(bindings).length) return undefined
  const value = claim.atom.args[valueRole]!
  return graphHash([claim.scope, predicate.ref, bindings, { kind: value.kind, unit: value.kind === 'number' ? value.unit : undefined }, claim.context, claim.validTime,
    claim.polarity, claim.modality, claim.condition, claim.sourceStatement?.qualifiers ?? null])
}

/** Open questions can have several answers. This does not prove completeness or relax admission. */
export function independentEvidenceSelection(query: string): boolean {
  if (/(?:吗|是否|是不是|有没有|能否|可否)\s*[？?。.!！]*$|^(?:is|are|was|were|do|does|did|can|could|would|should)\b/i.test(query.trim())) return false
  return /哪些|几个|多种|多项|分别|以及|什么|啥|哪种|哪几|\b(?:what|which|list|all|and)\b/i.test(query)
}
