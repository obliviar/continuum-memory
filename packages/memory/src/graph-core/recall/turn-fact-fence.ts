import type { GraphFactRef, GraphResult } from '@continuum-memory/contracts'

const key = (ref: Pick<GraphFactRef, 'id' | 'version'>) => JSON.stringify([ref.id, ref.version])

/** A turn fence narrows current reads; it is not authorization or a historical snapshot. */
export function parseTurnFactFence(value: unknown): GraphResult<ReadonlySet<string> | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  if (!Array.isArray(value) || value.length > 10000 || value.some(ref => !ref || ref.kind !== 'v4-fact'
    || typeof ref.id !== 'string' || !ref.id.trim() || !Number.isSafeInteger(ref.version) || ref.version < 1))
    return { ok: false, error: { code: 'invalid-request', message: 'Invalid turn fact visibility references' } }
  return { ok: true, value: new Set(value.map(key)) }
}

export function isTurnFactVisible(fence: ReadonlySet<string> | undefined, ref: Pick<GraphFactRef, 'id' | 'version'>): boolean {
  return fence === undefined || fence.has(key(ref))
}
