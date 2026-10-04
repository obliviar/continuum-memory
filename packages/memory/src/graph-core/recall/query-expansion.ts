/** Conservative, offline wording normalization. No generated facts or domain-specific synonyms.
 * Original query remains authoritative for identity, time, relation planning and literal focus.
 */
export function recallQueryVariants(query: string, protectedTerms: readonly string[] = []): string[] {
  const protectedSpans: { start: number; end: number }[] = []
  for (const match of query.matchAll(/"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|`[^`\n]*`/g))
    protectedSpans.push({ start: match.index!, end: match.index! + match[0].length })
  for (const term of new Set(protectedTerms.filter(Boolean))) {
    for (let at = query.indexOf(term); at >= 0; at = query.indexOf(term, at + 1)) protectedSpans.push({ start: at, end: at + term.length })
  }
  const safe = (start: number, end: number) => !protectedSpans.some(s => start < s.end && end > s.start)
  const edits: { start: number; end: number; text: string }[] = []
  const prefix = /^(?:请问一下|请问|麻烦问一下|麻烦问下|请告诉我)[，,\s]*/.exec(query)
  if (prefix && safe(0, prefix[0].length)) edits.push({ start: 0, end: prefix[0].length, text: '' })
  // Exact small equivalences only. In particular, do not remove 不/没, time, modality,
  // 谁, 哪种, 所有 or the requested attribute to make retrieval easier.
  for (const match of query.matchAll(/为啥|啥时候|啥|哪儿/g)) {
    const start = match.index!, end = start + match[0].length
    if (safe(start, end)) edits.push({ start, end, text: ({ 为啥: '为什么', 啥时候: '什么时候', 啥: '什么', 哪儿: '哪里' } as Record<string, string>)[match[0]]! })
  }
  let normalized = query
  for (const edit of edits.sort((a, b) => b.start - a.start)) normalized = normalized.slice(0, edit.start) + edit.text + normalized.slice(edit.end)
  normalized = normalized.trim()
  return normalized && normalized !== query && normalized.length <= 2000 ? [query, normalized] : [query]
}
