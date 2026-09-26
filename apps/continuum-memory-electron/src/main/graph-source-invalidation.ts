/** Erase the derived checkpoint before publishing ANY source mutation, including purge. */
export function withGraphSourceInvalidation<T extends { save: (payload: string) => void }>(persistence: T, invalidate: () => void): T {
  return { ...persistence, save(payload: string) { invalidate(); persistence.save(payload) } }
}
