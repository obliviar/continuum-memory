interface VectorRecord {
  id: string
  scope: MemoryV4Scope

  targetType:
    | 'episode'
    | 'claim'
    | 'entity'
    | 'relation'
    | 'rule'
    | 'summary'

  targetId: string
  targetVersion: number

  vector: number[]
  modelVersion: string
  dimensions: number

  contentHash: string
  projectionManifestId: string
}