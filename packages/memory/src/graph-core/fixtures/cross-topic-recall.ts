import type { GraphRecallRequest } from '@continuum-memory/contracts'
import type { GraphEntityRecord, GraphSemanticBundle } from '../domain/types'
import { createMemoryV4Repository } from '../../v4/repository/memory-v4-repository'
import { createV4GraphTestRepository, V4_TEST_SCOPE as scope } from './v4-direct-memory'
import { collectV4RecallInputs } from '../adapters/v4-recall-input'
import { graphHash, sourceHash, projectV4ScalarInputs } from '../adapters/v4-semantic-adapter'
import { V4_GRAPH_BUDGET, type V4GraphMemoryOptions } from '../adapters/v4-graph-memory'

// Explicit synthetic graph labels, not UIE output, not a human-reviewed benchmark.
const rows = [
  { id: 'tea', text: '用户喜欢喝乌龙茶', predicate: 'preference.drink', value: '乌龙茶' },
  { id: 'water', text: '用户喜欢喝气泡水', predicate: 'preference.drink', value: '气泡水' },
  { id: 'milk', text: '用户不喝牛奶', predicate: 'preference.milk', value: '牛奶', negative: true },
  { id: 'city', text: '用户现在住在杭州', predicate: 'profile.city', value: '杭州', from: 150 },
  { id: 'old-city', text: '用户以前住在北京', predicate: 'profile.city', value: '北京', to: 150 },
  { id: 'job', text: '用户的职业是软件工程师', predicate: 'profile.job', value: '软件工程师' },
  { id: 'project', text: '用户负责星河项目的记忆召回模块', predicate: 'project.role', value: '记忆召回模块' },
  { id: 'meeting', text: '星河项目的例会安排在每周三下午', predicate: 'project.meeting', value: '每周三下午' },
  { id: 'lin-drink', text: '小林喜欢喝咖啡', predicate: 'preference.drink', value: '咖啡', subject: 'lin' },
  { id: 'lin-job', text: '小林的职业是产品经理', predicate: 'profile.job', value: '产品经理', subject: 'lin' },
  { id: 'private', text: '用户的门禁编号是7319', predicate: 'private.code', value: '7319', private: true },
] as const

export interface CrossTopicCase {
  id: string; category: string; query: string; expected: readonly string[]
  mutation?: 'update' | 'delete' | 'revoke' | 'permission' | 'owner' | 'past' | 'missing-time'
  finalLimit?: number
  /** For full-query no-answer cases, unrelated candidates are quality errors, not access violations. */
  denied?: boolean
}
export const CROSS_TOPIC_CASES: readonly CrossTopicCase[] = [
  { id: 'drink-direct', category: '饮食', query: '我喜欢喝什么', expected: ['tea', 'water'] },
  { id: 'drink-rewrite', category: '饮食改写', query: '偏爱的饮品是哪种', expected: ['tea', 'water'] },
  { id: 'drink-colloquial', category: '饮食改写', query: '平时最爱来点啥饮料', expected: ['tea', 'water'] },
  { id: 'drink-negative', category: '否定', query: '我不喝哪种奶', expected: ['milk'] },
  { id: 'milk-direct', category: '否定', query: '用户不喝牛奶', expected: ['milk'] },
  { id: 'city-direct', category: '住址', query: '用户现在住在杭州', expected: ['city'] },
  { id: 'city-rewrite', category: '住址改写', query: '我目前定居在哪座城市', expected: ['city'] },
  { id: 'city-colloquial', category: '住址改写', query: '我现在落脚在哪儿', expected: ['city'] },
  { id: 'job-direct', category: '职业', query: '用户的职业是软件工程师', expected: ['job'] },
  { id: 'job-rewrite', category: '职业改写', query: '我是靠什么工作谋生的', expected: ['job'] },
  { id: 'job-colloquial', category: '职业改写', query: '我干哪一行', expected: ['job'] },
  { id: 'project-direct', category: '项目', query: '用户负责星河项目的记忆召回模块', expected: ['project'] },
  { id: 'project-rewrite', category: '项目改写', query: '星河里我分管哪块功能', expected: ['project'] },
  { id: 'meeting-direct', category: '时间', query: '星河项目的例会安排在每周三下午', expected: ['meeting'] },
  { id: 'meeting-rewrite', category: '时间改写', query: '星河团队每周什么时候开会', expected: ['meeting'] },
  { id: 'other-person', category: '他人', query: '小林喜欢喝什么', expected: ['lin-drink'] },
  { id: 'other-job', category: '他人', query: '小林做什么工作', expected: ['lin-job'] },
  { id: 'unknown-person', category: '陌生人', query: '小王的职业是什么', expected: [] },
  { id: 'no-answer', category: '无答案', query: '我的宠物叫什么名字', expected: [] },
  { id: 'no-answer-topic', category: '无答案', query: '星河项目的预算是多少', expected: [] },
  { id: 'negative-question', category: '否定问法', query: '我喜欢喝牛奶吗', expected: ['milk'] },
  { id: 'multiple', category: '多答案', query: '我喜欢哪些饮料', expected: ['tea', 'water'] },
  { id: 'limited-output', category: '排序预算', query: '我喜欢哪些饮料', expected: ['tea', 'water'], finalLimit: 1 },
  { id: 'updated', category: '更新', query: '用户喜欢喝豆浆', expected: ['tea'], mutation: 'update' },
  { id: 'deleted', category: '删除', query: '乌龙茶', expected: [], mutation: 'delete' },
  { id: 'withdrawn', category: '撤回', query: '乌龙茶', expected: [], mutation: 'revoke' },
  { id: 'policy', category: '权限', query: '乌龙茶', expected: [], mutation: 'permission' },
  { id: 'private', category: '隐私', query: '用户的门禁编号', expected: [] },
  { id: 'owner', category: '用户隔离', query: '乌龙茶', expected: [], mutation: 'owner', denied: true },
  { id: 'past', category: '时间过滤', query: '用户以前住在北京', expected: ['old-city'], mutation: 'past' },
  { id: 'unknown-time', category: '时间缺失', query: '乌龙茶', expected: [], mutation: 'missing-time' },
]

export function createCrossTopicFixture(c: CrossTopicCase) {
  const template = createV4GraphTestRepository().snapshot(), repository = createMemoryV4Repository({ now: () => 200 })
  repository.transaction(s => {
    for (const row of rows) {
      const person = 'subject' in row ? row.subject : scope.ownerId
      const fields = { subjectId: person, predicate: row.predicate, object: row.value, objectType: 'string' as const,
        normalizedValue: row.value, canonicalText: row.text, polarity: 'negative' in row ? 'negative' as const : 'positive' as const,
        modality: 'asserted' as const, status: 'active' as const, validFrom: 'from' in row ? row.from : 100,
        ...('to' in row ? { validTo: row.to } : {}), evidenceLinkIds: [`ev-${row.id}`] }
      const policy = { sensitivity: 'private' in row ? 'private' as const : 'normal' as const, sharePolicy: 'allow-remote' as const }
      s.facts.push({ ...structuredClone(template.facts[0]!), ...fields, ...policy, id: row.id, memoryKey: row.id, metadata: { graphTaskId: `fixture-claim:${row.id}` } })
      s.factVersions.push({ ...structuredClone(template.factVersions[0]!), ...fields, id: `v-${row.id}`, factId: row.id })
      s.episodes.push({ ...structuredClone(template.episodes[0]!), ...policy, id: `ep-${row.id}`, content: row.text, contentHash: sourceHash(row.text) })
      s.evidenceLinks.push({ ...structuredClone(template.evidenceLinks[0]!), id: `ev-${row.id}`, factId: row.id, episodeId: `ep-${row.id}` })
    }
    for (const [id, text] of [['owner', '用户'], ['lin', '小林']]) s.episodes.push({ ...structuredClone(template.episodes[0]!),
      id: `identity-${id}`, content: text, contentHash: sourceHash(text!), sharePolicy: 'allow-remote' })
  })
  if (c.mutation && !['owner', 'past', 'revoke'].includes(c.mutation)) repository.transaction(s => {
    const fact = s.facts.find(f => f.id === 'tea')!, ep = s.episodes.find(e => e.id === 'ep-tea')!
    if (c.mutation === 'update') {
      const old = s.factVersions.find(v => v.factId === 'tea')!; old.transactionClosedAt = 150
      Object.assign(fact, { object: '豆浆', normalizedValue: '豆浆', canonicalText: '用户喜欢喝豆浆', updatedAt: 150 })
      ep.content = fact.canonicalText; ep.contentHash = sourceHash(ep.content)
      s.factVersions.push({ ...old, id: 'v-tea-2', version: 2, transactionClosedAt: undefined, recordedAt: 150,
        object: fact.object, normalizedValue: fact.normalizedValue, canonicalText: fact.canonicalText })
    }
    if (c.mutation === 'delete') { ep.contentState = 'deleted'; ep.deletedAt = 150; delete ep.content }
    if (c.mutation === 'permission') { fact.sharePolicy = 'local-only'; ep.sharePolicy = 'local-only' }
    if (c.mutation === 'missing-time') delete fact.validFrom
  })
  const source = repository.snapshot()
  const gathered = collectV4RecallInputs(repository, { scope, expectedRevision: source.revision, now: 200, canRead: () => true })
  const base = projectV4ScalarInputs(gathered.inputs, scope, source.revision).semanticBundle
  const entities: GraphEntityRecord[] = [['owner', '用户', ['我', '本人']], ['lin', '小林', ['林同学']]].map(([id, name, aliases]) => ({
    ref: { kind: 'entity', id: id as string, version: 1 }, scope, entityType: 'person', canonicalName: name as string, aliases: aliases as string[],
    transactionTime: { recordedAt: 100, closedAt: null }, review: { status: 'accepted', reviewedAt: 100, reviewer: 'synthetic-fixture' },
    sensitivity: 'normal', sharePolicy: 'allow-remote', provenance: { producer: 'user', normalizerVersion: 'synthetic-v1',
      sources: [{ episodeId: `identity-${id}`, contentHash: sourceHash(name as string), locator: { kind: 'whole-content' } }] },
  }))
  const claims = base.claims.filter(claim => c.mutation !== 'revoke' || claim.fact.id !== 'tea').map(claim => {
    const fact = source.facts.find(f => f.id === claim.fact.id)!
    return { ...claim, ref: { ...claim.ref, id: `fixture-claim:${fact.id}` }, atom: { predicate: fact.predicate,
      args: { subject: { kind: 'entity' as const, ref: entities.find(e => e.ref.id === fact.subjectId)!.ref }, value: claim.atom.args.value! } } }
  })
  const predicates = [...new Set(source.facts.map(f => f.predicate))].map(name => ({ ...base.predicates[0]!,
    name, ref: { kind: 'predicate' as const, id: name, version: 1 },
    roles: { subject: { type: { entityType: 'person' }, required: true }, value: { type: 'string' as const, required: true } } }))
  const bundle: GraphSemanticBundle = { ...base, bundleId: `cross-topic:${graphHash([claims, entities])}`, claims, entities, predicates }
  let saved: string | undefined
  const options: V4GraphMemoryOptions = { repository, persistence: { load: () => saved, save: text => { saved = text } },
    authorizeScope: s => s.ownerId === scope.ownerId && s.agentId === scope.agentId && s.sessionId === undefined,
    canRead: record => record.sharePolicy === 'allow-remote' && record.sensitivity === 'normal',
    countTokens: text => Buffer.byteLength(text), now: () => 200, acceptedBundle: () => bundle }
  const request: GraphRecallRequest = { protocolVersion: 'memory-graph/v1', recallId: c.id, query: c.query,
    scope: c.mutation === 'owner' ? { ...scope, ownerId: 'other' } : scope, mode: 'direct-only',
    temporal: { knownAt: 200, valid: { kind: 'at', at: c.mutation === 'past' ? 120 : 200 } },
    budget: { ...V4_GRAPH_BUDGET, maxSeeds: c.finalLimit ?? 4 }, sharePolicies: ['allow-remote'], sensitivities: ['normal'] }
  return { repository, bundle, options, request }
}
