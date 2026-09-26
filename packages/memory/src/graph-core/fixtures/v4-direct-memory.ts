import { createMemoryV4Repository } from '../../v4/repository/memory-v4-repository'
export const V4_TEST_SCOPE = { ownerId: 'owner', agentId: 'agent' }
export function createV4GraphTestRepository() {
  const repo = createMemoryV4Repository({ now: () => 100 })
  repo.transaction(draft => {
    draft.episodes.push({ id: 'ep', scope: V4_TEST_SCOPE, actor: 'user', kind: 'message', contentState: 'available',
      content: 'I like tea', recordedAt: 100, sourceAttachmentIds: [], sensitivity: 'normal',
      sharePolicy: 'local-only', provenance: 'native-v4' })
    draft.evidenceLinks.push({ id: 'ev', factId: 'f', episodeId: 'ep', role: 'supports',
      strength: 'direct', active: true, createdAt: 100 })
    const fields = { subjectId: 'owner', predicate: 'likes', object: 'tea', objectType: 'string' as const,
      normalizedValue: 'tea', canonicalText: 'I like tea', polarity: 'positive' as const,
      modality: 'asserted' as const, status: 'active' as const, validFrom: 100, evidenceLinkIds: ['ev'] }
    draft.facts.push({ ...fields, id: 'f', scope: V4_TEST_SCOPE, memoryKey: 'likes', cardinality: 'multiple',
      recordedAt: 100, updatedAt: 100, extractionScore: 1, verificationScore: 1, evidenceScore: 1,
      utilityScore: 1, importance: 1, accessCount: 0, userConfirmed: true, verificationState: 'verified',
      supersedesFactIds: [], conflictsWithFactIds: [], sensitivity: 'normal', sharePolicy: 'local-only',
      origin: 'manual', extractorVersion: 'test', verifierVersion: 'test' })
    draft.factVersions.push({ ...fields, id: 'v1', factId: 'f', version: 1, operation: 'ADD',
      recordedAt: 100, reason: 'test' })
  })
  return repo
}
