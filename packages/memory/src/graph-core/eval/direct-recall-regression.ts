import { runDirectLexicalRegression } from './direct-lexical-regression'
import type { GraphRecallRequest } from '@continuum-memory/contracts'
import type { MemoryV4Snapshot } from '../../v4/domain/types'
import { createMemoryV4Repository } from '../../v4/repository/memory-v4-repository'
import { createV4GraphTestRepository, V4_TEST_SCOPE as scope } from '../fixtures/v4-direct-memory'
import { createV4GraphMemory, V4_GRAPH_BUDGET } from '../adapters/v4-graph-memory'
import { diagnoseV4GraphInputs } from '../adapters/v4-input-diagnostics'
import type { DirectSemanticOptions } from '../recall/direct-semantic'

// Synthetic, explicit gold evidence. Not a public benchmark or a human-reviewed user corpus.
function corpus() {
  const template = createV4GraphTestRepository().snapshot()
  const repository = createMemoryV4Repository({ now: () => 200 })
  repository.transaction(s => {
    for (const row of [
      { id: 'tea', text: '用户喜欢喝绿茶', predicate: 'preference.drink', value: '绿茶', polarity: 'positive' as const },
      { id: 'milk', text: '用户不喝牛奶', predicate: 'preference.milk', value: '牛奶', polarity: 'negative' as const },
      { id: 'city', text: '用户住在杭州', predicate: 'profile.city', value: '杭州', polarity: 'positive' as const },
    ]) {
      const fact = structuredClone(template.facts[0]!)
      Object.assign(fact, { id: row.id, canonicalText: row.text, predicate: row.predicate, object: row.value,
        normalizedValue: row.value, polarity: row.polarity, evidenceLinkIds: [`ev-${row.id}`] })
      s.facts.push(fact)
      s.episodes.push({ ...structuredClone(template.episodes[0]!), id: `ep-${row.id}`, content: row.text })
      s.evidenceLinks.push({ ...structuredClone(template.evidenceLinks[0]!), id: `ev-${row.id}`, factId: row.id, episodeId: `ep-${row.id}` })
      s.factVersions.push({ ...structuredClone(template.factVersions[0]!), id: `v-${row.id}`, factId: row.id,
        canonicalText: row.text, predicate: row.predicate, object: row.value, normalizedValue: row.value,
        polarity: row.polarity, evidenceLinkIds: [`ev-${row.id}`] })
    }
  })
  return repository
}
interface Case {
  id: string; category: string; query: string; expected: string[]
  mutate?: (snapshot: MemoryV4Snapshot) => void
  scope?: GraphRecallRequest['scope']; sharePolicies?: GraphRecallRequest['sharePolicies']
  polarity?: 'negative'; version?: number; knownGap?: string
}
export const DIRECT_RECALL_CASES: Case[] = [
  { id: 'direct', category: '直接问答', query: '喜欢喝绿茶', expected: ['tea'] },
  { id: 'rewrite', category: '改写', query: '绿茶是不是喜欢的饮料', expected: ['tea'] },
  { id: 'negative', category: '否定', query: '不喝牛奶', expected: ['milk'], polarity: 'negative' },
  { id: 'updated', category: '更新', query: '喜欢喝咖啡', expected: ['tea'], version: 2, mutate: s => {
    const fact = s.facts[0]!, old = s.factVersions[0]!
    old.transactionClosedAt = 150
    Object.assign(fact, { canonicalText: '用户喜欢喝咖啡', object: '咖啡', normalizedValue: '咖啡', updatedAt: 150 })
    s.episodes[0]!.content = '用户喜欢喝咖啡'
    s.factVersions.push({ ...old, id: 'v-tea-2', version: 2, operation: 'REFINE', transactionClosedAt: undefined,
      recordedAt: 150, canonicalText: fact.canonicalText, object: fact.object, normalizedValue: fact.normalizedValue })
  } },
  { id: 'deleted', category: '删除', query: '绿茶', expected: [], mutate: s => {
    s.episodes[0]!.contentState = 'deleted'; s.episodes[0]!.deletedAt = 150; delete s.episodes[0]!.content
  } },
  { id: 'unanswerable', category: '无答案', query: '宠物名字', expected: [] },
  { id: 'owner', category: '用户隔离', query: '绿茶', expected: [], scope: { ...scope, ownerId: 'other' } },
  { id: 'agent', category: 'Agent隔离', query: '绿茶', expected: [], scope: { ...scope, agentId: 'other' } },
  { id: 'session', category: '会话隔离', query: '绿茶', expected: [], scope: { ...scope, sessionId: 'other' } },
  { id: 'policy', category: '分享权限', query: '绿茶', expected: [], sharePolicies: ['allow-remote'] },
  { id: 'unknown-time', category: '时间缺失', query: '绿茶', expected: [], mutate: s => { delete s.facts[0]!.validFrom } },
  { id: 'semantic-rewrite', category: '无共同关键词的改写', query: '偏爱的饮品是哪种', expected: ['tea'],
    knownGap: '纯 BM25 对照仍缺少无共同关键词的匹配；默认结构化入口补充饮品偏好槽位' },
]

/** Default follows production; structuredRecall:false preserves the original keyword control. */
export async function runDirectRecallRegression(options: {
  prepareSemantic?: (snapshot: MemoryV4Snapshot) => Promise<DirectSemanticOptions>
  structuredRecall?: boolean
} = {}) {
  const rows = []
  for (const c of DIRECT_RECALL_CASES) {
    const repository = corpus()
    if (c.mutate) repository.transaction(c.mutate)
    const prepareStart = performance.now()
    const semantic = await options.prepareSemantic?.(repository.snapshot())
    const preparationMs = performance.now() - prepareStart
    const request: GraphRecallRequest = { protocolVersion: 'memory-graph/v1', recallId: c.id, query: c.query,
      scope: c.scope ?? scope, mode: 'direct-only', temporal: { knownAt: 200, valid: { kind: 'at', at: 200 } },
      budget: { ...V4_GRAPH_BUDGET }, sharePolicies: c.sharePolicies ?? ['local-only'], sensitivities: ['normal'] }
    const canRead = (record: { sharePolicy: 'local-only' | 'ask' | 'allow-remote' }) => request.sharePolicies.includes(record.sharePolicy)
    // Test operator is authorized to diagnose both synthetic scopes; the graph port below is not.
    const report = diagnoseV4GraphInputs(repository, { scope: request.scope, expectedRevision: repository.snapshot().revision,
      now: 200, canRead, authorizeScope: () => true })
    let checkpoint: string | undefined
    const port = createV4GraphMemory({ repository, persistence: { load: () => checkpoint, save: payload => { checkpoint = payload } },
      authorizeScope: s => s.ownerId === scope.ownerId && s.agentId === scope.agentId,
      canRead, countTokens: s => Buffer.byteLength(s), now: () => 200, semantic, structuredRecall: options.structuredRecall })
    const recallStart = performance.now()
    const result = await port.recall(request)
    const elapsedMs = performance.now() - recallStart
    const actual = result.ok ? result.value.evidence.claims.flatMap(claim => claim.kind === 'direct' ? [claim.fact.id] : []).sort() : []
    const expectedDenial = c.id === 'owner' || c.id === 'agent'
    const boundaryPassed = expectedDenial ? !result.ok && result.error.code === 'scope-denied' : result.ok
    const evidencePassed = result.ok ? result.value.evidence.claims.every(claim => claim.kind === 'direct'
      && claim.sources.length === 1 && claim.sources[0]!.episodeId === `ep-${claim.fact.id}`
      && claim.polarity === repository.snapshot().facts.find(f => f.id === claim.fact.id)?.polarity
      && claim.fact.version === Math.max(...repository.snapshot().factVersions.filter(v => v.factId === claim.fact.id).map(v => v.version))) : expectedDenial
    const qualityPassed = boundaryPassed && evidencePassed && JSON.stringify(actual) === JSON.stringify([...c.expected].sort())
    rows.push({ id: c.id, category: c.category, query: c.query, expected: c.expected, actual, qualityPassed,
      boundaryPassed, evidencePassed, knownGap: options.structuredRecall === false ? c.knownGap ?? null : null,
      missing: c.expected.filter(id => !actual.includes(id)), unexpected: actual.filter(id => !c.expected.includes(id)),
      eligible: report.eligible, excluded: report.excluded, reasons: report.reasons,
      preparationMs, elapsedMs, searchScope: result.ok ? result.value.trace.searchScope : [],
      completeness: result.ok ? result.value.trace.completeness : null,
      outcome: result.ok ? result.value.trace.stopReason : result.error.code })
  }
  return { schema: 'direct-recall-regression/v1', corpus: 'synthetic-not-human-reviewed',
    structuredRecall: options.structuredRecall !== false,
    tests: rows.length, qualityPassed: rows.filter(row => row.qualityPassed).length,
    knownGaps: rows.filter(row => row.knownGap && !row.qualityPassed).length, cases: rows,
    lexicalChecks: runDirectLexicalRegression() }
}
