/** Shared asynchronous embedding boundary for every runtime adapter. */
export interface Embedder {
  /** Stable fingerprint used to isolate persisted vector spaces. */
  readonly model: string
  /** Number of values returned by each embedding operation. */
  readonly dimensions: number
  /** Embed one text as an L2-normalized vector. */
  embed(text: string): Promise<number[]>
  /** Optional optimized batch operation. */
  embedBatch?(texts: string[]): Promise<number[][]>
  /** Release native/runtime resources held by the implementation. */
  dispose?(): Promise<void>
}
