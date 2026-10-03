import { describe, expect, it } from 'vitest'
import { isUserSourceWithdrawal } from './source-recall-review-policy'

describe('raw source access is independent of optional Claim publication', () => {
  it('does not turn a deferred unresolved Claim into a source withdrawal', () => {
    expect(isUserSourceWithdrawal({ reviewer: 'user', status: 'pending',
      retrieval: { retain: false, reason: 'unresolved-subject' } })).toBe(false)
  })
  it('honors explicit user rejection or withdrawal on an approved Claim', () => {
    for (const status of ['rejected', 'approved'] as const)
      expect(isUserSourceWithdrawal({ reviewer: 'user', status,
        retrieval: { retain: false, reason: 'user requested' } })).toBe(true)
    expect(isUserSourceWithdrawal({ reviewer: 'user', status: 'approved',
      retrieval: { retain: true, reason: 'confirmed' } })).toBe(false)
  })
  it('does not reject valid raw sources solely because machine extraction failed', () => {
    expect(isUserSourceWithdrawal({ reviewer: 'policy', status: 'rejected',
      retrieval: { retain: false, reason: 'invalid-evidence-span' } })).toBe(false)
  })
})
