import { describe, expect, it } from 'vitest'
import { isProxy, reactive } from 'vue'
import { graphReviewIpcFields, graphReviewTimeError } from '../../shared/graph-review-ipc'

describe('graph review IPC fields', () => {
  it('turns reactive form values into structured-cloneable plain objects', () => {
    const form = reactive({ context: { negation: 'positive', condition: 'none', conditionText: '',
      time: 'none', speaker: 'self', speakerName: '' }, identities: { subject: 'new', object: 'new' } })
    expect(isProxy(form.context)).toBe(true)
    expect(() => structuredClone(form.context)).toThrow()
    const fields = graphReviewIpcFields(form.context, form.identities)
    expect(isProxy(fields.context)).toBe(false)
    expect(isProxy(fields.identities)).toBe(false)
    expect(structuredClone(fields)).toEqual({ context: { negation: 'positive', condition: 'none',
      conditionText: '', time: 'none', speaker: 'self', speakerName: '' },
    identities: { subject: 'new', object: 'new' } })
  })

  it('checks the exact date format used by graph admission', () => {
    expect(graphReviewTimeError('none')).toBeNull()
    expect(graphReviewTimeError('2026-09-29')).toBeNull()
    expect(graphReviewTimeError('2026-9-29')).toContain('补零')
    expect(graphReviewTimeError('2026-02-30')).toContain('有效')
  })
})
