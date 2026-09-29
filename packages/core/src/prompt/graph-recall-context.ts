import type { GraphAnswerEvidenceBundle, GraphClaimRef, GraphVersionRef } from '@continuum-memory/contracts'

const key = (ref: GraphVersionRef<string>) => JSON.stringify([ref.kind, ref.id, ref.version])
const fail = (): never => { throw new Error('Inconsistent graph retrieval explanation') }

/** A retrieval path must connect exact evidence records; it never licenses a derived fact. */
export function validateGraphRecallContext(evidence: GraphAnswerEvidenceBundle): void {
  const context = evidence.relationRecall
  if (!context) return
  const claims = new Set(evidence.claims.map(c => key(c.ref)))
  const relations = new Map((evidence.relations ?? []).map(r => [key(r.ref), r]))
  if (!evidence.relationManifestId || context.pathPolicy !== 'one-shortest-path-per-root-and-claim'
    || context.conflictAudit !== 'not-supported' || !['in', 'out', 'both'].includes(context.direction)
    || !Number.isSafeInteger(context.maxHops) || context.maxHops < 0
    || !context.kinds.length || context.kinds.some(k => !['entails', 'contradicts', 'causes', 'precedes', 'explains'].includes(k))) fail()
  const pathKey = (root: GraphClaimRef, target: GraphClaimRef) => JSON.stringify([key(root), key(target)])
  const paths = new Map(context.paths.map(p => [pathKey(p.root, p.target), p]))
  if (paths.size !== context.paths.length) fail()
  for (const path of paths.values()) {
    if (!claims.has(key(path.root)) || !claims.has(key(path.target))
      || !Number.isSafeInteger(path.depth) || path.depth < 0 || path.depth > context.maxHops) fail()
    if (path.depth === 0) {
      if (key(path.root) !== key(path.target) || path.parent !== null || path.via !== null) fail()
      continue
    }
    if (!path.parent || !path.via) fail()
    const parent = paths.get(pathKey(path.root, path.parent!)), relation = relations.get(key(path.via!))
    if (!parent || parent.depth !== path.depth - 1 || !relation || !context.kinds.includes(relation.kind)) fail()
    const forward = key(relation!.from) === key(path.parent!) && key(relation!.to) === key(path.target)
    const reverse = key(relation!.to) === key(path.parent!) && key(relation!.from) === key(path.target)
    if (relation!.kind === 'contradicts' || context.direction === 'both') { if (!forward && !reverse) fail() }
    else if (context.direction === 'out' ? !forward : !reverse) fail()
  }
  const frontier = new Set<string>()
  for (const item of context.depthFrontier) {
    const id = pathKey(item.root, item.node), path = paths.get(id)
    if (!path || path.depth !== context.maxHops || frontier.has(id)) fail()
    frontier.add(id)
  }
  for (const [id, path] of paths) if (path.depth === context.maxHops && !frontier.has(id)) fail()
  const located = new Set(context.paths.map(p => key(p.target)))
  if ([...claims].some(id => !located.has(id))) fail()
  const targets = new Set<string>()
  for (const alternative of context.causalAlternatives) {
    if (!claims.has(key(alternative.target)) || targets.has(key(alternative.target))
      || !['complete-within-declared-scope', 'incomplete', 'not-checked'].includes(alternative.coverage)
      || alternative.interpretation !== 'candidates-may-coexist'
      || alternative.hasMultipleCauses !== (alternative.causes.length > 1)
      || ((context.direction === 'out' || !context.kinds.includes('causes')) && alternative.coverage !== 'not-checked')) fail()
    targets.add(key(alternative.target))
    const seenClaims = new Set<string>(), seenRelations = new Set<string>()
    for (const group of alternative.causes) {
      if (!group.claims.length || !group.relations.length) fail()
      const linkedClaims = new Set<string>()
      for (const ref of group.relations) {
        const relation = relations.get(key(ref))
        if (!relation || relation.kind !== 'causes' || !context.kinds.includes('causes')
          || key(relation.to) !== key(alternative.target) || seenRelations.has(key(ref))) fail()
        seenRelations.add(key(ref)); linkedClaims.add(key(relation!.from))
      }
      for (const ref of group.claims) {
        if (!claims.has(key(ref)) || !linkedClaims.delete(key(ref)) || seenClaims.has(key(ref))) fail()
        seenClaims.add(key(ref))
      }
      if (linkedClaims.size) fail()
    }
    if ([...relations.values()].some(r => r.kind === 'causes' && key(r.to) === key(alternative.target)
      && !seenRelations.has(key(r.ref)))) fail()
  }
  if (targets.size !== claims.size) fail()
}
