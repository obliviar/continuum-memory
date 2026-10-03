import type { GraphProjectionSnapshot } from '../domain/types'
import { graphHash } from '../adapters/v4-semantic-adapter'

// Bounded derived cache of reference keys only; source text/permissions are never cached here.
const cache = new Map<string, ReadonlyMap<string, readonly string[]>>()
export function entityClaimIndex(projection: GraphProjectionSnapshot) {
  const key = graphHash([projection.manifest.scope, projection.manifest.manifestId, projection.manifest.semanticFingerprint])
  const previous = cache.get(key)
  if (previous) return { index: previous, reused: true }
  const index = new Map<string, string[]>()
  for (const claim of projection.semanticBundle.claims) {
    const claimKey = graphHash(claim.ref)
    for (const entityKey of new Set(Object.values(claim.atom.args).flatMap(term => term.kind === 'entity' ? [graphHash(term.ref)] : []))) {
      const list = index.get(entityKey) ?? []; list.push(claimKey); index.set(entityKey, list)
    }
  }
  if (cache.size >= 4) cache.delete(cache.keys().next().value!)
  cache.set(key, index)
  return { index, reused: false }
}
