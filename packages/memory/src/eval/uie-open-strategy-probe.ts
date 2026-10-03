import type { UieExtraction, UieSchema } from '../long-term/local-uie'
import { planUieSchema } from '../long-term/uie-schema-planner'

/** Experimental goals only. None of these configurations claims proven zero-shot quality. */
export const UIE_OPEN_PROBE_STRATEGIES = ['domain-baseline', 'flat-general', 'predicate-centered',
  'state-centered', 'clause-predicate', 'predicate-followup'] as const
export type UieOpenProbeStrategy = typeof UIE_OPEN_PROBE_STRATEGIES[number]
type Extract = (text: string, schema: UieSchema) => Promise<UieExtraction>
export interface ProbeCall {
  sourceStart: number
  sourceEnd: number
  text: string
  schema: UieSchema
  raw: unknown
  elapsedMs: number
}

const predicateSchema: UieSchema = [
  '实体提及', { 谓词或关系短语: ['主体', '客体', '其他参与者'] },
]
export function probeSchema(strategy: UieOpenProbeStrategy, text: string): UieSchema {
  if (strategy === 'domain-baseline') return planUieSchema(text).schema
  if (strategy === 'flat-general') return ['实体提及', '谓词', '关系短语', '事件触发词', '状态词', '评价词']
  if (strategy === 'state-centered') return [
    { 状态词: ['状态所属对象'] }, { 评价词: ['评价对象', '评价者'] }, '时间', '地点',
  ]
  if (strategy === 'predicate-followup') return ['谓词', '关系短语', '状态词', '评价词']
  return structuredClone(predicateSchema)
}

/** Naive clause splitting is an ablation, not a production recommendation. Original context is retained. */
function windows(source: string, split: boolean) {
  if (!split) return [{ text: source, start: 0, end: source.length }]
  return [...source.matchAll(/[^，,；;。！？!?\n]+/gu)].map(match => ({ text: match[0], start: match.index!,
    end: match.index! + match[0].length }))
}

export async function runUieOpenProbe(source: string, strategy: UieOpenProbeStrategy, extract: Extract): Promise<{
  source: string; strategy: UieOpenProbeStrategy; calls: ProbeCall[]; followupTruncated: boolean
}> {
  const calls: ProbeCall[] = []
  let followupTruncated = false
  const invoke = async (window: ReturnType<typeof windows>[number], schema: UieSchema) => {
    const started = performance.now()
    const result = await extract(window.text, schema)
    calls.push({ sourceStart: window.start, sourceEnd: window.end, text: window.text,
      schema: structuredClone(schema), raw: result.rawOutput, elapsedMs: performance.now() - started })
    return result
  }
  for (const window of windows(source, strategy === 'clause-predicate')) {
    const result = await invoke(window, probeSchema(strategy, window.text))
    if (strategy !== 'predicate-followup') continue
    // Model output, never gold labels or verb dictionaries, determines follow-up goals.
    const relations = [...new Set(result.entities.filter(e => ['谓词', '关系短语', '状态词', '评价词'].includes(e.label))
      .filter(e => e.text.length <= 40 && window.text.includes(e.text)).map(e => e.text))]
    followupTruncated ||= relations.length > 8
    for (const relation of relations.slice(0, 8)) {
      await invoke(window, [`关系“${relation}”的主体`, `关系“${relation}”的客体`,
        `关系“${relation}”的其他参与者`])
    }
  }
  return { source, strategy, calls, followupTruncated }
}

/** Only literal span coverage: it must NOT be reported as complete relation-tuple accuracy. */
export function observedSpans(call: ProbeCall): string[] {
  const found: string[] = []
  const chars = Array.from(call.text)
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (!value || typeof value !== 'object') return
    const item = value as Record<string, unknown>
    if (typeof item.text === 'string' && Number.isInteger(item.start) && Number.isInteger(item.end)
      && Number(item.start) >= 0 && Number(item.end) > Number(item.start) && Number(item.end) <= chars.length
      && chars.slice(Number(item.start), Number(item.end)).join('') === item.text) found.push(item.text)
    Object.values(item).filter(v => v !== null && typeof v === 'object').forEach(visit)
  }
  visit(call.raw)
  return [...new Set(found)]
}
