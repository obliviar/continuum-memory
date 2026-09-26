import { describe, expect, it } from 'vitest'
import { parseUieOutput, uieReviewCandidates } from './uie-extractor'

describe('local UIE-base output adapter', () => {
  it('deduplicates root spans and preserves nested relation evidence', () => {
    const text = '《雪满庭》由祝云舟主演。'
    const raw = {
      影视作品: [
        {
          text: '雪满庭', start: 1, end: 4, probability: 0.96,
          relations: { 主演: [{ text: '祝云舟', start: 6, end: 9, probability: 0.91 }] },
        },
        { text: '雪满庭', start: 1, end: 4, probability: 0.96 },
      ],
      人物: [{ text: '祝云舟', start: 6, end: 9, probability: 0.94 }],
    }
    const result = parseUieOutput(text, raw)
    expect(result.entities).toHaveLength(2)
    expect(result.relations).toMatchObject([
      { subject: { text: '雪满庭' }, predicate: '主演', object: { text: '祝云舟' }, score: 0.91 },
    ])
    expect(uieReviewCandidates(text, result)).toMatchObject([
      { content: '雪满庭的主演：祝云舟', metadata: { requiresReview: true, sharePolicy: 'local-only' } },
    ])
  })

  it('rejects hallucinated spans and does not infer a user identity from a third party', () => {
    const text = '他说张三住在北京。'
    const result = parseUieOutput(text, {
      姓名: [{ text: '张三', start: 2, end: 4, probability: 0.99 }],
      地点: [{ text: '上海', start: 6, end: 8, probability: 0.99 }],
    })
    expect(result.entities).toEqual([])
    expect(uieReviewCandidates(text, result)).toEqual([])
  })

  it('turns an explicit first-person field into a review-only memory candidate', () => {
    const text = '我叫张三。'
    const result = parseUieOutput(text, {
      姓名: [{ text: '张三', start: 2, end: 4, probability: 0.98 }],
    })
    expect(uieReviewCandidates(text, result)).toMatchObject([
      {
        content: '用户姓名/名字：张三',
        metadata: { predicate: 'profile.name', requiresReview: true, confidence: 0.98 },
      },
    ])
  })

  it('uses code-point offsets when text contains emoji', () => {
    const result = parseUieOutput('🙂张三', {
      人物: [{ text: '张三', start: 1, end: 3, probability: 0.8 }],
    })
    expect(result.entities[0]).toMatchObject({ text: '张三', start: 1, end: 3 })
  })
})
