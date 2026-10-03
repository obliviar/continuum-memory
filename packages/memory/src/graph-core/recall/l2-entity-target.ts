/** Exact authorized Entity identity, supplied by the host, never inferred from a name match. */
export interface L2EntityBinding {
  readonly key: string
  readonly names: readonly string[]
}
const normalize = (s: string) => s.normalize('NFKC').trim().toLowerCase()

/** Match explicit known names only. No unknown-name extraction, pronoun resolution or role inference. */
export function planL2EntityTarget(query: string, catalog: readonly L2EntityBinding[]) {
  const text = normalize(query), names = new Map<string, Set<string>>()
  for (const entity of catalog) for (const raw of entity.names) {
    const name = normalize(raw)
    // Single characters inside prose are too ambiguous; exact whole-name queries remain supported.
    if (!name || (name.length < 2 && text !== name)) continue
    const keys = names.get(name) ?? new Set<string>(); keys.add(entity.key); names.set(name, keys)
  }
  const spans: { start: number; end: number; keys: Set<string> }[] = []
  for (const [name, keys] of names) {
    for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
      const end = at + name.length
      if ((/^[a-z0-9_]/.test(name) && /[a-z0-9_]/.test(text[at - 1] ?? ''))
        || (/[a-z0-9_]$/.test(name) && /[a-z0-9_]/.test(text[end] ?? ''))) continue
      spans.push({ start: at, end, keys })
    }
  }
  // Prefer a complete longer name over its contained prefix; do not guess at partial overlaps.
  let furthest = -1
  const mentions = spans.sort((a, b) => a.start - b.start || b.end - a.end).filter(span => {
    if (span.end <= furthest) return false
    furthest = span.end; return true
  })
  const overlapping = mentions.some((span, i) => i > 0 && span.start < mentions[i - 1]!.end)
  return {
    matches: (bindings: readonly L2EntityBinding[]) => !overlapping && mentions.every(mention =>
      bindings.some(binding => mention.keys.has(binding.key))),
    scope: [`seed-entity-mentions:${mentions.length}`,
      ...(mentions.some(m => m.keys.size > 1) ? ['seed-entity-target:ambiguous-identity'] : []),
      ...(overlapping ? ['seed-entity-target:overlapping-names'] : [])],
  }
}
