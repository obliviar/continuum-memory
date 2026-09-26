/** Full calendar days only; partial dates require an explicit planning policy. */
export const GRAPH_CALENDAR_DATE = /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b|(\d{4})年(\d{1,2})月(\d{1,2})日?/g

export function graphCalendarDates(normalized: string) {
  return [...normalized.matchAll(GRAPH_CALENDAR_DATE)].map(match => {
    const year = Number(match[1] ?? match[4])
    const month = Number(match[2] ?? match[5])
    const day = Number(match[3] ?? match[6])
    const dayUtc = Date.UTC(year, month - 1, day)
    const checked = new Date(dayUtc)
    if (year < 1000 || checked.getUTCFullYear() !== year || checked.getUTCMonth() !== month - 1 || checked.getUTCDate() !== day)
      throw new Error('Invalid explicit date')
    return { index: match.index!, text: match[0], dayUtc,
      key: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` }
  })
}
