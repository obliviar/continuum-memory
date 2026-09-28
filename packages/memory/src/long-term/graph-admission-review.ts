import { createHash } from 'node:crypto'
import type { FactContext, GraphExtractionRun } from './graph-extraction-result'

export interface GraphAdmissionChoices {
  negation: 'positive' | 'negative' | 'unknown'
  condition: 'none' | 'conditional' | 'unknown'
  conditionText?: string
  time: string
  speaker: 'self' | 'reported' | 'unknown'
  speakerName?: string
}

export interface GraphAdmissionDecision {
  sourceRevision: string
  context: FactContext
  identities: Readonly<Record<string, string>>
}

/** User-reviewed interpretation is separate from the immutable model extraction. */
export function reviewGraphAdmission(run: GraphExtractionRun, sourceFactId: string,
  choices: GraphAdmissionChoices, identities: Readonly<Record<string, string>>): GraphAdmissionDecision {
  const source = run.factCandidates.find(fact => fact.id === sourceFactId)
  if (!source)
    throw new Error('Reviewed graph fact is absent from the exact source')
  if (run.status !== 'complete' || createHash('sha256').update(run.sourceText).digest('hex') !== run.sourceRevision
    || source.evidenceSpan.start < 0 || source.evidenceSpan.end > run.sourceText.length
    || source.evidenceSpan.start >= source.evidenceSpan.end)
    throw new Error('Graph admission requires complete extraction and exact source evidence')
  if (!['positive', 'negative', 'unknown'].includes(choices.negation)
    || !['none', 'conditional', 'unknown'].includes(choices.condition)
    || !['self', 'reported', 'unknown'].includes(choices.speaker))
    throw new Error('Incomplete graph context review')
  const conditionText = choices.conditionText?.normalize('NFKC').trim() ?? ''
  const speakerName = choices.speakerName?.normalize('NFKC').trim() ?? ''
  if (choices.condition === 'conditional' && !conditionText)
    throw new Error('Conditional context requires the reviewed condition text')
  if (choices.speaker === 'reported' && !speakerName)
    throw new Error('Reported context requires the reviewed speaker')
  if (choices.speaker === 'reported' && speakerName.toLowerCase() === 'user')
    throw new Error('Reported speaker cannot be the user; choose self instead')
  if (conditionText.length > 500 || speakerName.length > 200)
    throw new Error('Reviewed graph context is too long')
  if (choices.time !== 'unknown' && choices.time !== 'none'
    && (!/^\d{4}-\d{2}-\d{2}$/u.test(choices.time)
      || Number.isNaN(Date.parse(`${choices.time}T00:00:00.000Z`))
      || new Date(Date.parse(`${choices.time}T00:00:00.000Z`)).toISOString().slice(0, 10) !== choices.time))
    throw new Error('Reviewed time must be an exact YYYY-MM-DD date, none, or unknown')
  const context: FactContext = {
    negation: choices.negation === 'unknown'
      ? { value: null, resolution: 'unresolved' }
      : { value: choices.negation === 'negative', resolution: 'resolved' },
    condition: choices.condition === 'unknown' ? { value: null, resolution: 'unresolved' }
      : choices.condition === 'none' ? { value: null, resolution: 'absent' }
        : { value: conditionText, resolution: 'resolved' },
    time: choices.time === 'unknown' ? { value: null, resolution: 'unresolved' }
      : choices.time === 'none' ? { value: null, resolution: 'absent' }
        : { value: choices.time, resolution: 'resolved' },
    speaker: choices.speaker === 'unknown' ? { value: null, resolution: 'unresolved' }
      : { value: choices.speaker === 'self' ? 'user' : speakerName, resolution: 'resolved' },
  }
  return { sourceRevision: run.sourceRevision, context, identities: { ...identities } }
}
