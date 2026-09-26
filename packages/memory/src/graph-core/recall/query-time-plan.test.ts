import { describe, expect, it } from 'vitest'
import type { GraphResult, GraphTemporalQuery } from '@continuum-memory/contracts'
import { planGraphQueryTime } from './query-time-plan'
import type { GraphQueryTimeOptions } from './query-time-plan'

function value<T>(result: GraphResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
const temporal: GraphTemporalQuery = { valid: { kind: 'at', at: 123 }, knownAt: 456 }
const options: GraphQueryTimeOptions = { referenceTime: Date.parse('2026-09-21T00:15:00+08:00'), utcOffsetMinutes: 480 }
const stamp = (day: string) => Date.parse(`${day}T00:00:00+08:00`)

describe('deterministic graph query time planning', () => {
  it.each([
    ['昨天', '2026-09-20', '2026-09-21'],
    ['今天', '2026-09-21', '2026-09-22'],
    ['前天', '2026-09-19', '2026-09-20'],
    ['大前天', '2026-09-18', '2026-09-19'],
    ['明天', '2026-09-22', '2026-09-23'],
    ['上周', '2026-09-14', '2026-09-21'],
    ['本周', '2026-09-21', '2026-09-28'],
    ['上上周', '2026-09-07', '2026-09-14'],
    ['上个月', '2026-08-01', '2026-09-01'],
    ['本月', '2026-09-01', '2026-10-01'],
    ['去年', '2025-01-01', '2026-01-01'],
    ['今年', '2026-01-01', '2027-01-01'],
    ['yesterday', '2026-09-20', '2026-09-21'],
    ['last week', '2026-09-14', '2026-09-21'],
  ])('resolves %s using the host offset and preserves knownAt', (expression, from, to) => {
    const plan = value(planGraphQueryTime(`张三${expression}为什么没有上班？`, temporal, options))
    expect(plan.temporal).toEqual({ valid: { kind: 'overlap', from: stamp(from), to: stamp(to) }, knownAt: 456 })
    expect(plan.expression).toBe(expression)
    expect(plan.lexicalQuery).toBe('张三 为什么没有上班?')
    expect(plan.source).toBe('query')
  })

  it('does not use the UTC calendar date as the local date near midnight', () => {
    const plan = value(planGraphQueryTime('昨天发生什么', temporal, { referenceTime: Date.parse('2026-01-01T01:00:00Z'), utcOffsetMinutes: -300 }))
    expect(plan.temporal.valid).toEqual({ kind: 'overlap', from: Date.parse('2025-12-30T05:00:00Z'), to: Date.parse('2025-12-31T05:00:00Z') })
  })

  it.each([
    ['2024-03-01T12:00:00+08:00', '昨天', '2024-02-29', '2024-03-01'],
    ['2024-03-15T12:00:00+08:00', '上个月', '2024-02-01', '2024-03-01'],
    ['2026-01-01T12:00:00+08:00', '上个月', '2025-12-01', '2026-01-01'],
    ['2026-01-04T12:00:00+08:00', '本周', '2025-12-29', '2026-01-05'],
  ])('handles calendar boundaries at %s', (reference, cue, from, to) => {
    const plan = value(planGraphQueryTime(`${cue}未上班`, temporal, { ...options, referenceTime: Date.parse(reference) }))
    expect(plan.temporal.valid).toEqual({ kind: 'overlap', from: stamp(from), to: stamp(to) })
  })

  it.each(['2026年9月20日', '2026-09-20', '2026/9/20'])('plans a full explicit day: %s', day => {
    expect(value(planGraphQueryTime(`张三${day}未上班`, temporal, options)).temporal.valid)
      .toEqual({ kind: 'overlap', from: stamp('2026-09-20'), to: stamp('2026-09-21') })
  })

  it.each(['从2026年9月10日到2026年9月20日', '2026-09-10 to 2026-09-20', '2026/9/10至2026/9/20'])('includes both boundary days: %s', range => {
    const plan = value(planGraphQueryTime(`张三${range}为什么没上班？`, temporal, options))
    expect(plan.temporal.valid).toEqual({ kind: 'overlap', from: stamp('2026-09-10'), to: stamp('2026-09-21') })
    expect(plan.lexicalQuery).toBe('张三 为什么没上班?')
  })

  it.each(['2026-02-30', '2026-09-20到2026-09-10', '2026-09-10和2026-09-20',
    '昨天和今天', '昨天2026-09-20', '上周三', '昨天下午', '2026-09-20之前',
    '最近几天', '9月20日', '2026年9月', '下周', '今天15:00'])('rejects ambiguous or unsupported time: %s', time => {
    expect(planGraphQueryTime(`张三${time}未上班`, temporal, options)).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  })

  it('preserves caller time when no time expression is present and does not mutate it', () => {
    const input = structuredClone(temporal)
    const plan = value(planGraphQueryTime('张三为什么没上班', input, options))
    expect(plan.source).toBe('caller')
    expect(plan.temporal).toEqual(input)
    Object.assign(plan.temporal, { knownAt: 999 })
    expect(input.knownAt).toBe(456)
  })

  it.each([{ utcOffsetMinutes: 841 }, { utcOffsetMinutes: 1.5 }, { referenceTime: NaN }, { referenceTime: 1e16 }])(
    'rejects invalid host reference options %j', patch => {
      expect(planGraphQueryTime('昨天没上班', temporal, { ...options, ...patch })).toMatchObject({ ok: false })
    })
})
