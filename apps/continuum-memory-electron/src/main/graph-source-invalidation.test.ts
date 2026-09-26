import { describe, expect, it } from 'vitest'
import { withGraphSourceInvalidation } from './graph-source-invalidation'

describe('graph source publication invalidation', () => {
  it('invalidates before publishing source updates and preserves persistence operations', () => {
    const order: string[] = []
    const persistence = { save: (_payload: string) => { order.push('source') }, load: () => 'old' }
    const wrapped = withGraphSourceInvalidation(persistence, () => { order.push('graph') })
    wrapped.save('new')
    expect(order).toEqual(['graph', 'source'])
    expect(wrapped.load()).toBe('old')
  })
  it('blocks publication if derived data cannot be erased', () => {
    let published = false
    const wrapped = withGraphSourceInvalidation({ save: (_payload: string) => { published = true } }, () => { throw new Error('disk') })
    expect(() => wrapped.save('new')).toThrow('disk')
    expect(published).toBe(false)
  })
})
