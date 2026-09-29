/** Electron IPC cannot serialize Vue's reactive Proxy objects. The form has only scalar fields. */
export function graphReviewIpcFields<C extends object, I extends object>(
  context: C | undefined, identities: I | undefined,
): { context: C | undefined; identities: I | undefined } {
  return {
    context: context ? { ...context } : undefined,
    identities: identities ? { ...identities } : undefined,
  }
}

export function graphReviewTimeError(time: string): string | null {
  if (!time || time === 'none' || time === 'unknown') return null
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(time))
    return '时间请填 YYYY-MM-DD、none 或 unknown（月份和日期需要补零）。'
  const parsed = Date.parse(`${time}T00:00:00.000Z`)
  return Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== time
    ? '时间不是有效的日历日期。' : null
}
