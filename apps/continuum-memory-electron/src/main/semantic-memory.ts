import {
  createOnnxEmbedder,
  type OnnxEmbedderIntegrityState,
  type OnnxEmbedderProgress,
} from '@continuum-memory/embedding-onnx'

export {
  SEMANTIC_MEMORY_DTYPE,
  SEMANTIC_MEMORY_EXPECTED_DIMENSION,
  SEMANTIC_MEMORY_FINGERPRINT,
  SEMANTIC_MEMORY_MODEL,
  SEMANTIC_MEMORY_PROBE_VERSION,
  SEMANTIC_MEMORY_REVISION,
  SEMANTIC_MEMORY_RUNTIME,
} from '@continuum-memory/embedding-onnx'

export type SemanticModelIntegrityState = OnnxEmbedderIntegrityState

export interface SemanticModelProgress extends Omit<OnnxEmbedderProgress, 'status'> {
  status: OnnxEmbedderProgress['status'] | 'indexing'
  total?: number
  ready?: number
  pending?: number
}

/** Electron compatibility wrapper around the reusable ONNX embedder package. */
export function createSemanticMemoryService(
  cacheDir: string,
  onProgress?: (progress: SemanticModelProgress) => void,
) {
  const embedder = createOnnxEmbedder({
    cacheDir,
    onProgress: progress => onProgress?.(progress),
  })
  return {
    ...embedder,
    // Kept for the existing IPC/status payload.
    markerPath: embedder.manifestPath,
  }
}

export type SemanticMemoryService = ReturnType<typeof createSemanticMemoryService>
