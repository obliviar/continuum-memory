import type { GraphScope, SourceRecallEvidence } from '@continuum-memory/contracts'
import type { CaptureSource, CaptureSnapshot } from '../../long-term/capture-repository'
import type { GraphExtractionResultStore } from '../../long-term/graph-extraction-result'
import { inferMemoryPrivacy, isSafeMemoryContent } from '../../long-term/memory-extractor'
import { projectOpenAssertions } from '../repository/open-assertions'
import { projectCapturedInformation } from '../repository/captured-information'

const normalized = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, '')
const generic = /^(我|你|他|她|它|我们|他们|这里|那里|用户|项目|设备|故障|对方)$/u
// An arbitrary label such as “负责人” may still describe a person. Only recognized
// object categories can relax the contextual bridge check; unknown labels cannot.
const objectTypes = new Set(['organization', 'location', 'film', 'book', 'song', 'album', 'course',
  'interest', 'project', '样品', '设备', '试剂', '模块', '接口', '配置', '任务'])
export function includesRecallTerm(text: string, term: string): boolean {
  const value = normalized(text), needle = normalized(term)
  if (!needle) return false
  for (let at = value.indexOf(needle); at >= 0; at = value.indexOf(needle, at + 1)) {
    if (/[a-z0-9]$/i.test(needle) && /[a-z0-9]/i.test(value[at + needle.length] ?? '')) continue
    if (/^[a-z0-9]/i.test(needle) && /[a-z0-9]/i.test(value[at - 1] ?? '')) continue
    return true
  }
  return false
}
export interface OpenSourceRecallOptions {
  captures: CaptureSnapshot
  extractions: Pick<GraphExtractionResultStore, 'list' | 'openReviews'>
  scope: GraphScope
  query: string
  canRead: (source: CaptureSource) => boolean
  maxHops?: number
  maxResults?: number
  maxCharacters?: number
  maxNodes?: number
}
/** Bounded navigation on valid source evidence, without publishing new facts or identities. */
export function recallOpenSources(options: OpenSourceRecallOptions): SourceRecallEvidence[] {
  const { captures, scope, query } = options
  if (!query.trim()) return []
  const clamp = (v: number | undefined, fallback: number, ceiling: number) =>
    Number.isFinite(v) ? Math.max(0, Math.min(ceiling, Math.floor(v!))) : fallback
  const hops = clamp(options.maxHops, 3, 4), limit = clamp(options.maxResults, 8, 20)
  const characters = clamp(options.maxCharacters, 6000, 20000), nodes = clamp(options.maxNodes, 64, 128)
  if (!limit || !characters || !nodes) return []
  const valid = new Set(projectCapturedInformation(captures, scope).map(i => i.source.captureId))
  const records = projectOpenAssertions(captures, options.extractions, scope, { includeKnownFacts: true })
  const rejected = new Set(records.filter(r => r.review.status === 'rejected').map(r => r.source.captureId))
  const sources = captures.sources.filter(s => valid.has(s.id) && !rejected.has(s.id)
    && isSafeMemoryContent(s.turn!.userMessage)
    && inferMemoryPrivacy(s.turn!.userMessage).sensitivity !== 'secret' && options.canRead(structuredClone(s)))
  const sourceMap = new Map(sources.map(s => [s.id, s]))
  const observations = records.filter(r => r.review.status !== 'rejected' && sourceMap.has(r.source.captureId))
  const terms = [...new Set([
    ...observations.flatMap(r => r.participants.map(p => p.text)).filter(t => t.length > 1 && !generic.test(t) && includesRecallTerm(query, t)),
    ...(query.match(/[\p{L}_-]*[a-zA-Z][a-zA-Z0-9_-]*\d+[a-zA-Z0-9_-]*/gu) ?? []),
    ...query.split(/[\s，。！？?、：:]+/u).filter(t => t.length > 1),
  ])]
  const selected = new Map<string, { depth: number; score: number; path: SourceRecallEvidence['path'] }>()
  for (const source of sources) {
    const matches = terms.filter(t => includesRecallTerm(source.turn!.userMessage, t))
    if (matches.length) selected.set(source.id, { depth: 0, score: matches.reduce((sum, t) => sum + t.length, 0), path: [] })
  }
  const frontier = [...selected.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, Math.min(32, nodes)).map(([id]) => id)
  for (const id of [...selected.keys()]) if (!frontier.includes(id)) selected.delete(id)
  const bySource = new Map<string, typeof observations>(), byMention = new Map<string, typeof observations>()
  const typedMentions = new Map<string, string>()
  for (const record of observations) {
    bySource.set(record.source.captureId, [...(bySource.get(record.source.captureId) ?? []), record])
    for (const p of record.participants) {
      const key = normalized(p.text)
      if (p.typeCandidate !== 'unknown') typedMentions.set(`${record.source.captureId}\0${key}`, p.typeCandidate)
      if (key.length < 2 || generic.test(key)) continue
      byMention.set(key, [...(byMention.get(key) ?? []), record])
    }
  }
  for (let i = 0; i < frontier.length && selected.size < nodes; i++) {
    const id = frontier[i]!, origin = selected.get(id)!
    if (origin.depth >= hops) continue
    for (const record of bySource.get(id) ?? []) for (const p of record.participants) {
      const key = normalized(p.text)
      if (key.length < 2 || generic.test(key)) continue
      const strongIdentifier = /[a-zA-Z].*\d|\d.*[a-zA-Z]/u.test(key)
      for (const next of (byMention.get(key) ?? []).slice(0, 8)) {
        const target = next.source.captureId
        if (selected.has(target) || selected.size >= nodes) continue
        const other = next.participants.find(q => normalized(q.text) === key)!
        if (p.typeCandidate !== 'unknown' && other.typeCandidate !== 'unknown' && p.typeCandidate !== other.typeCandidate) continue
        const fromType = typedMentions.get(`${id}\0${key}`), toType = typedMentions.get(`${target}\0${key}`)
        const typedObject = fromType !== undefined && fromType === toType && objectTypes.has(fromType)
        if (!strongIdentifier && !typedObject && !record.participants.some(q => normalized(q.text) !== key && !generic.test(q.text)
          && next.participants.some(n => normalized(n.text) === normalized(q.text)))) continue
        selected.set(target, { depth: origin.depth + 1, score: origin.score * 0.8,
          path: [...origin.path, { sourceId: id, relation: record.relationText, mention: p.text, uncertainIdentity: true }] })
        frontier.push(target)
      }
    }
  }
  const output: SourceRecallEvidence[] = []
  let used = 0
  for (const [id, hit] of [...selected].sort((a, b) => b[1].score - a[1].score)) {
    if (output.length >= limit) break
    const source = sourceMap.get(id)!, content = source.turn!.userMessage
    if (used + content.length > characters) continue
    output.push({ citation: `S${output.length + 1}`, content, recordedAt: source.createdAt, scope: source.scope,
      source: { captureId: source.id, revision: source.revision, contentHash: source.contentHash, start: 0, end: content.length }, path: hit.path })
    used += content.length
  }
  return output
}
