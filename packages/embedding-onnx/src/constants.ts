export const SEMANTIC_MEMORY_MODEL = 'Xenova/bge-small-zh-v1.5'
export const SEMANTIC_MEMORY_REVISION = 'fcecc3c5fef6becfa2b2bdda15c1c938857be534'
export const SEMANTIC_MEMORY_DTYPE = 'q8'
export const SEMANTIC_MEMORY_EXPECTED_DIMENSION = 512
export const SEMANTIC_MEMORY_FINGERPRINT = `${SEMANTIC_MEMORY_MODEL}@${SEMANTIC_MEMORY_REVISION}:${SEMANTIC_MEMORY_DTYPE}:mean-normalized:v1`
export const SEMANTIC_MEMORY_PROBE_VERSION = 'bge-small-zh-probe-v1'
export const SEMANTIC_MEMORY_RUNTIME = {
  transformers: '3.8.1',
  onnxRuntimeNode: '1.21.0',
}