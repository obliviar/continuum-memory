/** Erase the derived checkpoint before publishing ANY source mutation, including purge. */
export function withGraphSourceInvalidation<T extends { save: (payload: string) => void }>(persistence: T, invalidate: (nextPayload: string) => void): T {
  return { ...persistence, save(payload: string) { invalidate(payload); persistence.save(payload) } }
}
