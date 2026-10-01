import type { GraphScope } from '@continuum-memory/contracts'
import type { MemoryFactV4 } from '../../v4/domain/types'

export const DIRECT_STRUCTURED_POLICY = 'direct-structured-slots-v1'

/** A deliberately finite self-query grammar, not keyword expansion or a general intent classifier. */
export function directQuerySlot(query: string): 'preference.drink' | undefined {
  const text = query.normalize('NFKC').trim().toLowerCase().replace(/[?？。!！]+$/u, '').trim()
  const chinese = text.replace(/^(?:请问|请告诉我|告诉我)[,，\s]*/u, '')
  const subject = '(?:(?:我|本人|用户)(?:的)?)?'
  const end = '(?:呢|啊)?'
  if ([
    `${subject}(?:平时)?(?:偏爱|喜欢)的?(?:饮品|饮料)(?:是|有)?(?:哪种|哪些|什么|啥)${end}`,
    `${subject}(?:平时)?(?:喜欢|偏爱|爱)喝(?:什么|啥|哪些(?:饮品|饮料)?)${end}`,
    `${subject}(?:饮品|饮料)(?:偏好|喜好)(?:是|有)?(?:什么|啥|哪些)${end}`,
  ].some(pattern => new RegExp(`^(?:${pattern})$`, 'u').test(chinese))
    || /^(?:what|which) (?:drinks|beverages) do i (?:like|prefer)(?: to drink)?$/.test(text)
    || /^what do i (?:like|prefer) to drink$/.test(text)) return 'preference.drink'
  return undefined
}

/** Only adds existing, already-authorized exact-field candidates. No inferred value or polarity. */
export function searchDirectStructured(query: string, facts: readonly MemoryFactV4[], scope: GraphScope, enabled = true) {
  const slot = enabled ? directQuerySlot(query) : undefined
  const hits = slot ? facts.filter(fact => fact.subjectId === scope.ownerId && fact.predicate === slot)
    .map(fact => ({ id: fact.id, score: 1 })).sort((a, b) => a.id.localeCompare(b.id)) : []
  // When this field exists in the eligible corpus, other channels cannot replace the self/slot target.
  // Corpora with only legacy/general predicates retain their existing lexical/vector behavior.
  const constrain = !!slot && facts.some(fact => fact.predicate === slot)
  return { hits, constrain, scope: [DIRECT_STRUCTURED_POLICY,
    !enabled ? 'structured:disabled' : slot ? `structured-slot:${slot}` : 'structured:no-supported-slot',
    `structured-candidates:${hits.length}`, ...(constrain ? ['structured-slot-filter:active'] : [])] }
}
