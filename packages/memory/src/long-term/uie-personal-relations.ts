import type { UieMention, UieRelation } from './local-uie'

interface FieldBinding {
  predicate: string
  objectLabel: string
  cue: RegExp
  suffix?: RegExp
}

// These patterns bind a model-extracted field to an explicit local subject.
// They never supply an object that UIE did not extract, or resolve the subject's identity.
const preference: FieldBinding = { predicate: '喜欢', objectLabel: '兴趣',
  cue: /^(?:(?:最|很|非常|特别|比较|真的|一直|也|还|不|并不|不太|曾经|以前|现在|可能|再也|不再))*?(?:喜欢|偏好|爱)(?:吃|喝|玩|打|看|听)?/u }
const bindings: Record<string, FieldBinding> = {
  喜好: preference, 爱好: preference, 喜欢: preference,
  课程: { predicate: '修读课程', objectLabel: '课程',
    cue: /^(?:(?:每(?:周|星期|天)[一二三四五六日天\d]*|(?:这|本|上|下)学期|今天|明天|昨天|现在|目前|通常|一般|还|也|都|要|会|正在|在|不|没|没有|已经|曾经)\s*)*(?:上|学习|选修|修读)/u },
  上课地点: { predicate: '上课地点', objectLabel: '地点',
    cue: /^(?:(?:通常|一般|平时|今天|明天|现在|目前|都|也|不)\s*)*在/u, suffix: /^\s*(?:上课|学习)/u },
  姓名: { predicate: '姓名', objectLabel: '姓名', cue: /^(?:叫|的(?:名字|姓名)(?:叫|是))/u },
  职业: { predicate: '职业', objectLabel: '职业',
    cue: /^(?:(?:现在|目前)?(?:是|担任|从事)|的职业是)(?:一名|一个)?/u },
  所在地: { predicate: '居住地', objectLabel: '地点', cue: /^(?:(?:现在|目前)?住在|的(?:所在地|居住地)是)/u },
  当前项目: { predicate: '参与项目', objectLabel: '项目', cue: /^(?:正在|在|目前在)(?:做|开发|研究|推进)/u },
}

/** All offsets here, like UIE itself, are Unicode code-point offsets. */
export function personalUieRelations(source: string, fields: readonly UieMention[]): UieRelation[] {
  const chars = Array.from(source)
  const result: UieRelation[] = []
  const sentenceBoundary = /[。！？!?；;\n]/u
  const clauseBoundary = /[，,。！？!?；;：:\n]/u
  for (const field of fields) {
    const binding = bindings[field.label]
    if (!binding) continue
    let sentenceStart = field.start, sentenceEnd = field.end, clauseStart = field.start
    while (sentenceStart > 0 && !sentenceBoundary.test(chars[sentenceStart - 1]!)) sentenceStart--
    while (sentenceEnd < chars.length && !sentenceBoundary.test(chars[sentenceEnd]!)) sentenceEnd++
    while (clauseStart > sentenceStart && !clauseBoundary.test(chars[clauseStart - 1]!)) clauseStart--
    // Quoted first person has a different possible speaker; leave it to relation extraction.
    if (/[“”「」『』"‘’']/u.test(chars.slice(sentenceStart, sentenceEnd).join(''))) continue
    const prefix = chars.slice(clauseStart, field.start).join('')
    const subject = /^\s*(?:(?:其实|现在|目前|今天|今晚|昨天|明天|最近|平时|通常|一般|另外|而且|不过|但是|所以|然后|这周|本周|上周|下周)\s*)*我(?!们)/u.exec(prefix)
    if (!subject) continue
    const subjectEnd = clauseStart + Array.from(subject[0]).length
    const beforeField = chars.slice(subjectEnd, field.start).join('')
    const cue = binding.cue.exec(beforeField)
    if (!cue) continue
    let cursor = subjectEnd + Array.from(cue[0]).length
    // A later item can share the predicate only through a contiguous coordinated
    // list of extracted fields, never arbitrary text or another person's clause.
    const preceding = fields.filter(item => bindings[item.label]?.predicate === binding.predicate
      && item.start >= cursor && item.end <= field.start).sort((a, b) => a.start - b.start || b.end - a.end)
    for (const item of preceding) {
      if (item.start < cursor) continue
      const gap = chars.slice(cursor, item.start).join('')
      if (!/^(?:\s|和|与|及|、|以及)*$/u.test(gap)) break
      cursor = item.end
    }
    if (!/^(?:\s|和|与|及|、|以及)*$/u.test(chars.slice(cursor, field.start).join(''))) continue
    if (binding.suffix && !binding.suffix.test(chars.slice(field.end, sentenceEnd).join(''))) continue
    const relation: UieRelation = {
      subject: { label: '人物', text: '我', start: subjectEnd - 1, end: subjectEnd, score: field.score },
      predicate: binding.predicate, object: { ...field, label: binding.objectLabel }, score: field.score,
      evidenceSpan: { start: sentenceStart, end: sentenceEnd },
    }
    const duplicate = result.find(item => item.subject.start === relation.subject.start
      && item.predicate === relation.predicate && item.object.start < field.end && item.object.end > field.start)
    if (!duplicate) result.push(relation)
    else if (relation.score > duplicate.score) Object.assign(duplicate, relation)
  }
  return result
}
