import type { GraphResult, GraphTemporalQuery } from '@continuum-memory/contracts'
import { graphCalendarDates, GRAPH_CALENDAR_DATE } from './calendar-dates'

const DAY = 86400000
const RELATIVE = /大前天|前天|昨天|今天|明天|上上周|上周|本周|这周|上个月|上月|本月|这个月|去年|今年|\b(?:yesterday|today|tomorrow|last\s+week|this\s+week|last\s+month|this\s+month|last\s+year|this\s+year)\b/gi
const VAGUE = /前几天|最近|近期|近来|过去|上次|那天|当时|\b(?:recently|lately|ago|previously)\b/i
const UNSUPPORTED = /下周|下个月|下月|后天|星期|周[一二三四五六日天1-7]|早上|上午|下午|晚上|凌晨|中午|\d{1,2}(?:点|时|:\d{2})|\b(?:morning|afternoon|evening|night|next\s+(?:week|month|year))\b/i
const PARTIAL = /\d{1,4}\s*(?:年|月|日|号)|\b\d{4}[-/]\d{1,2}\b/

export interface GraphQueryTimeOptions {
  /** Resolved once by the host; never derived from knownAt or Date.now(). */
  readonly referenceTime: number
  /** Fixed UTC offset in minutes; +480 is UTC+08:00. Not an IANA/DST zone. */
  readonly utcOffsetMinutes: number
}

export interface GraphQueryTimePlan {
  readonly version: 'graph-query-time/v1'
  readonly originalQuery: string
  readonly lexicalQuery: string
  readonly temporal: GraphTemporalQuery
  readonly source: 'caller' | 'query'
  readonly expression: string | null
  readonly referenceTime: number
  readonly utcOffsetMinutes: number
}

/** Recognized relative/vague cues must not quietly pass through lexical search. */
export function hasUnresolvedGraphTime(query: string): boolean {
  const normalized = query.normalize('NFKC')
  return [...normalized.matchAll(RELATIVE)].length > 0 || VAGUE.test(normalized) || UNSUPPORTED.test(normalized)
}

/**
 * Opt-in calendar planning. Query dates replace only valid time; knownAt remains
 * explicit caller state. Two complete dates joined by 到/至/to include both days.
 * Unsupported or competing time expressions return an error, never a guessed range.
 */
export function planGraphQueryTime(
  query: string, temporal: GraphTemporalQuery, options: GraphQueryTimeOptions,
): GraphResult<GraphQueryTimePlan> {
  const invalid = (message: string): GraphResult<GraphQueryTimePlan> => ({ ok: false, error: { code: 'invalid-request', message } })
  const normalized = query.normalize('NFKC').trim()
  if (!normalized || normalized.length > 2000 || !Number.isSafeInteger(options.referenceTime)
    || !Number.isFinite(new Date(options.referenceTime).getTime())
    || !Number.isSafeInteger(options.utcOffsetMinutes) || Math.abs(options.utcOffsetMinutes) > 840
    || !Number.isSafeInteger(temporal.knownAt)
    || !(temporal.valid.kind === 'at' ? Number.isSafeInteger(temporal.valid.at)
      : temporal.valid.kind === 'overlap' && Number.isSafeInteger(temporal.valid.from)
        && Number.isSafeInteger(temporal.valid.to) && temporal.valid.from < temporal.valid.to))
    return invalid('Invalid time planning reference, UTC offset or temporal query')
  let dates: ReturnType<typeof graphCalendarDates>
  try { dates = graphCalendarDates(normalized) }
  catch { return invalid('Invalid calendar date in query') }
  const relative = [...normalized.matchAll(RELATIVE)]
  const withoutDates = normalized.replace(GRAPH_CALENDAR_DATE, ' ')
  if (VAGUE.test(normalized) || UNSUPPORTED.test(normalized) || PARTIAL.test(withoutDates)
    || relative.length > 1 || dates.length > 2 || (dates.length > 0 && relative.length > 0))
    return invalid('Time expression is incomplete, ambiguous or unsupported; provide a resolved time range')
  if ((dates.length > 0 || relative.length > 0) && /之前|以前|之后|以后|截至|以来|\b(?:before|after|since|until)\b/i.test(normalized))
    return invalid('Open-ended time qualifiers require an explicit query plan')

  const offset = options.utcOffsetMinutes * 60000
  let from: number | undefined
  let to: number | undefined
  let start = 0
  let end = 0
  if (dates.length > 0) {
    const first = dates[0]!
    const last = dates[dates.length - 1]!
    if (dates.length === 2) {
      const connector = normalized.slice(first.index + first.text.length, last.index).trim()
      if (!/^(?:到|至|~|—|–|-|to|through)$/i.test(connector) || last.dayUtc < first.dayUtc)
        return invalid('Use an ordered range of two full calendar dates joined by 到 or to')
    }
    from = first.dayUtc - offset
    to = last.dayUtc + DAY - offset
    start = first.index
    if (normalized.slice(0, start).endsWith('从')) start--
    end = last.index + last.text.length
  }
  else if (relative.length === 1) {
    const match = relative[0]!
    start = match.index!
    end = start + match[0].length
    const cue = match[0].toLowerCase().replace(/\s+/g, ' ')
    // Shift to a pseudo-UTC calendar, compute boundaries, then undo the shift.
    const local = new Date(options.referenceTime + offset)
    const year = local.getUTCFullYear()
    const month = local.getUTCMonth()
    const today = Date.UTC(year, month, local.getUTCDate())
    if (year < 1000 || year > 9998) return invalid('Reference calendar year is outside the supported range')
    const days: Record<string, number> = { 大前天: -3, 前天: -2, 昨天: -1, 今天: 0, 明天: 1, yesterday: -1, today: 0, tomorrow: 1 }
    if (cue in days) { from = today + days[cue]! * DAY; to = from + DAY }
    else if (['上上周', '上周', '本周', '这周', 'last week', 'this week'].includes(cue)) {
      const monday = today - ((local.getUTCDay() + 6) % 7) * DAY
      const weeks = cue === '上上周' ? -2 : ['上周', 'last week'].includes(cue) ? -1 : 0
      from = monday + weeks * 7 * DAY
      to = from + 7 * DAY
    }
    else if (['上个月', '上月', '本月', '这个月', 'last month', 'this month'].includes(cue)) {
      const delta = ['上个月', '上月', 'last month'].includes(cue) ? -1 : 0
      from = Date.UTC(year, month + delta, 1)
      to = Date.UTC(year, month + delta + 1, 1)
    }
    else {
      const delta = ['去年', 'last year'].includes(cue) ? -1 : 0
      from = Date.UTC(year + delta, 0, 1)
      to = Date.UTC(year + delta + 1, 0, 1)
    }
    from -= offset
    to -= offset
  }
  const planned = from !== undefined && to !== undefined
  const lexicalQuery = planned ? `${normalized.slice(0, start)} ${normalized.slice(end)}`.trim() : normalized
  return { ok: true, value: {
    version: 'graph-query-time/v1', originalQuery: query, lexicalQuery,
    temporal: planned ? { valid: { kind: 'overlap', from: from!, to: to! }, knownAt: temporal.knownAt } : structuredClone(temporal),
    source: planned ? 'query' : 'caller', expression: planned ? normalized.slice(start, end) : null,
    referenceTime: options.referenceTime, utcOffsetMinutes: options.utcOffsetMinutes,
  } }
}
