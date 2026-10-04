export const RERANKER_MODEL = 'Xenova/bge-reranker-base'
export const RERANKER_REVISION = 'cbd4c47f870c4bb77534e06b8853de9c6e958b82'
export const RERANKER_FILES = [
  { path: 'config.json', bytes: 782, gitBlob: 'ef36f7221740ddc57b6cfae14977840d1fc0fc95' },
  { path: 'tokenizer_config.json', bytes: 443, gitBlob: '059214673d9d6d2ee319411e2ffec8c024b816d5' },
  { path: 'special_tokens_map.json', bytes: 279, gitBlob: '68171d1ff68b731a33d119708476692c094a466b' },
  { path: 'tokenizer.json', bytes: 17098079, sha256: '48564c5c7d3fa64d85d95e65414a542385f88b0f128fd8d4163fd7a57f2be05c' },
  { path: 'onnx/model_quantized.onnx', bytes: 279301077, sha256: 'dd98f3e67837d23210a6b7550c08cced4f61845b940ac45be3565840a10f3244' },
] as const
