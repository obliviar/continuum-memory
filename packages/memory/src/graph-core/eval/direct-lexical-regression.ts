import { createDirectLexicalIndex } from '../recall/direct-lexical'

/** Additional held-separate lexical cases: no tuning of golden evidence in the original 12-case corpus. */
export function runDirectLexicalRegression() {
  const cases = [
    { id: 'weak-han-overlap', query: '喜欢喝绿茶', texts: ['喜欢喝绿茶', '不喝牛奶'], expected: [0] },
    { id: 'punctuation-boundary', query: '绿茶', texts: ['喜欢绿茶', '绿色，茶杯'], expected: [0] },
    { id: 'mixed-language-boundary', query: '绿茶', texts: ['喜欢绿茶', '绿 tea 茶'], expected: [0] },
    { id: 'single-han-query', query: '茶', texts: ['绿茶', '牛奶'], expected: [0] },
    { id: 'english-question', query: 'What do I like?', texts: ['I like tea', 'I live in Hangzhou'], expected: [0] },
    { id: 'function-words-only', query: 'What is my?', texts: ['I like tea', 'My city is Hangzhou'], expected: [] },
    { id: 'preserve-opposing-facts', query: '牛奶', texts: ['用户喝牛奶', '用户不喝牛奶', '用户喝绿茶'], expected: [0, 1] },
    { id: 'multiple-relevant-facts', query: '喜欢', texts: ['喜欢绿茶', '喜欢跑步', '住在杭州'], expected: [0, 1] },
    { id: 'unanswerable-with-user-wrapper', query: '用户的宠物名字是什么', texts: ['用户喜欢绿茶', '用户住在杭州'], expected: [] },
    { id: 'other-domain', query: '异常检测', texts: ['研究异常检测', '学习数学分析', '研究历史'], expected: [0] },
    { id: 'full-width-latin', query: 'ＴＥＡ', texts: ['I like tea', 'I drink coffee'], expected: [0] },
  ]
  return cases.map(c => {
    const index = createDirectLexicalIndex(c.query)
    const scope = { ownerId: 'lexical-eval', agentId: 'agent' }
    c.texts.forEach((content, i) => index.upsert({ id: String(i), content, scope, state: 'active' }))
    const actual = index.search(c.query, { scope, limit: 100, minScore: 0.2 }).map(hit => Number(hit.id)).sort((a,b) => a-b)
    return { id: c.id, expected: c.expected, actual, passed: JSON.stringify(actual) === JSON.stringify(c.expected) }
  })
}
