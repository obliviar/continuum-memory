import { describe, expect, it } from 'vitest'
import { createV4GraphTestRepository, V4_TEST_SCOPE as scope } from '../fixtures/v4-direct-memory'
import { diagnoseV4GraphInputs } from './v4-input-diagnostics'

function setup() {
  const repository = createV4GraphTestRepository()
  const options = { scope, expectedRevision: 1, now: 200, canRead: () => true, authorizeScope: () => true }
  return { repository, options }
}
describe('V4 L1 input diagnostics', () => {
  it('accounts for eligible records without exposing IDs or contents or changing data', () => {
    const { repository, options } = setup()
    const before = repository.snapshot()
    const report = diagnoseV4GraphInputs(repository, options)
    expect(report).toMatchObject({ inScope: 1, eligible: 1, excluded: 0 })
    expect(JSON.stringify(report)).not.toContain('I like tea')
    expect(JSON.stringify(report)).not.toContain('factId')
    expect(repository.snapshot()).toEqual(before)
  })
  it('reports first failure only rather than double counting the same fact', () => {
    const { repository, options } = setup()
    repository.transaction(s => { s.facts[0]!.verificationState = 'pending'; delete s.facts[0]!.validFrom })
    const report = diagnoseV4GraphInputs(repository, { ...options, expectedRevision: 2 })
    expect(report).toMatchObject({ inScope: 1, eligible: 0, excluded: 1 })
    expect(report.reasons.find(r => r.reason === 'unverified')?.count).toBe(1)
    expect(report.reasons.find(r => r.reason === 'unknown-time')?.count).toBe(0)
    expect(report.reasons.reduce((sum, r) => sum + r.count, 0)).toBe(report.excluded)
  })
  it('counts sharing exclusions but omits other owners and session records', () => {
    const { repository, options } = setup()
    expect(diagnoseV4GraphInputs(repository, { ...options, canRead: () => false }).reasons)
      .toContainEqual({ reason: 'access-denied', label: '当前分享或访问策略不允许', count: 1 })
    for (const otherScope of [{ ...scope, ownerId: 'other' }, { ...scope, sessionId: 'session' }])
      expect(diagnoseV4GraphInputs(repository, { ...options, scope: otherScope })).toMatchObject({ inScope: 0 })
  })
  it('rejects unauthorized and stale diagnostics', () => {
    const { repository, options } = setup()
    expect(() => diagnoseV4GraphInputs(repository, { ...options, authorizeScope: () => false })).toThrow('denied')
    expect(() => diagnoseV4GraphInputs(repository, { ...options, expectedRevision: 0 })).toThrow('revision')
    let calls = 0
    expect(() => diagnoseV4GraphInputs(repository, { ...options, authorizeScope: () => ++calls === 1 })).toThrow('revoked')
  })
})
