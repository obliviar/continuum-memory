import type { EntityMention, FactContext, OpenAssertionCandidate } from './graph-extraction-result'

/** High precision syntactic fallback. Unknown prose remains in the source inbox. */
export function extractLocalOpenAssertions(text: string): { entities: EntityMention[]; assertions: OpenAssertionCandidate[] } {
  const entities: EntityMention[] = []
  const assertions: OpenAssertionCandidate[] = []
  for (const sentence of text.matchAll(/[^。！？!?\n]+[。！？!?]?/gu)) {
    const raw = sentence[0]
    const content = raw.trim().replace(/[。！？!?]$/u, '')
    const start = sentence.index! + raw.indexOf(content)
    if (!content || content.length > 500) continue
    let relationText: string | undefined
    let parts: { text: string; role: string }[] = []
    const explicit = /^(.+?)与(.+?)的关系(?:是|为)[：:]?(.+)$/u.exec(content)
    const placement = /^(.+?)把(.+?)(放入|放进|存入|移入|送到)(.+)$/u.exec(content)
    const binary = /^(.+?)(存放在|保存在|放在|依赖于|依赖|位于|安装在|连接到|连接着|使用电源|供电来自|使用|负责)(.+)$/u.exec(content)
    const event = /^(.+?)发生(?:了)?(.+)$/u.exec(content)
    if (explicit) {
      relationText = explicit[3]!.trim()
      parts = [{ text: explicit[1]!.trim(), role: 'subject' }, { text: explicit[2]!.trim(), role: 'object' }]
    } else if (placement) {
      relationText = placement[3]!
      parts = [{ text: placement[1]!.trim(), role: 'agent' }, { text: placement[2]!.trim(), role: 'theme' },
        { text: placement[4]!.trim(), role: 'destination' }]
    } else if (binary) {
      relationText = binary[2]!
      parts = [{ text: binary[1]!.trim(), role: 'subject' }, { text: binary[3]!.trim(), role: 'object' }]
    } else if (event) {
      relationText = content.slice(event[1]!.length, content.length - event[2]!.length)
      parts = [{ text: event[1]!.trim(), role: 'subject' }, { text: event[2]!.trim(), role: 'event' }]
    }
    if (!relationText || !parts.length || parts.some(part => !part.text || part.text.length > 150)) continue
    const relationStart = start + content.lastIndexOf(relationText)
    let cursor = 0
    const participants: OpenAssertionCandidate['participants'] = []
    for (const part of parts) {
      const position = content.indexOf(part.text, cursor)
      if (position < 0) break
      cursor = position + part.text.length
      const id = `open-local-mention:${start + position}:${start + cursor}`
      if (!entities.some(entity => entity.id === id)) entities.push({ id, text: part.text, type: 'unknown',
        span: { start: start + position, end: start + cursor }, modelScore: 1 })
      participants.push({ mentionId: id, role: part.role })
    }
    if (participants.length !== parts.length) continue
    // A rule match certifies span alignment only. It does not certify polarity or truth.
    const context: FactContext = {
      negation: { value: null, resolution: 'unresolved' }, condition: { value: null, resolution: 'unresolved' },
      time: { value: null, resolution: 'unresolved' }, speaker: { value: null, resolution: 'unresolved' },
    }
    assertions.push({ id: `open-local:${start}`, relationText, relationSpan: { start: relationStart, end: relationStart + relationText.length },
      participants, evidenceSpan: { start, end: sentence.index! + raw.length }, modelScore: 1, context })
  }
  return { entities, assertions }
}
