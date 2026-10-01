import type { GraphClaimReview } from '@continuum-memory/memory'

/** Deferring an unresolved Claim does not revoke access to its valid raw source. */
export function isUserSourceWithdrawal(review: Pick<GraphClaimReview, 'reviewer' | 'status' | 'retrieval'>): boolean {
  return review.reviewer === 'user' && (review.status === 'rejected'
    || (review.status === 'approved' && !review.retrieval.retain))
}
