import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { inferMemoryPrivacy, isSafeMemoryContent } from '@continuum-memory/memory'
import type { MemoryCandidate } from '@continuum-memory/memory'

const ENTITY_LABELS = new Set([
  '人物', '地点', '组织机构', '项目', '企业', '影视作品', '图书作品',
  '歌曲', '历史人物', '学校', '国家', '行政区',
])
const FIELD_LABELS = new Set(['姓名', '职业', '所在地', '喜好', '当前项目'])
const MAX_OUTPUT_BYTES = 2_000_000
const EXTRACTOR_VERSION = 'local-uie-base-v1'

export interface UieMention {
  label: string
  text: string
  start: number
  end: number
  score: number
}

export interface UieRelation {
  subject: UieMention
  predicate: string
  object: UieMention
  score: number
}

export interface UieExtraction {
  model: 'uie-base'
  entities: UieMention[]
  fields: UieMention[]
  relations: UieRelation[]
}

export interface LocalUieOptions {
  pythonPath: string
  modelHome: string
  scriptPath: string
  timeoutMs?: number
}

export function createLocalUieExtractor(options: LocalUieOptions) {
  const modelWeights = join(options.modelHome, 'taskflow', 'information_extraction', 'uie-base', 'model_state.pdparams')
  return {
    isReady: () => existsSync(options.pythonPath) && existsSync(options.scriptPath) && existsSync(modelWeights),
    async extract(text: string): Promise<UieExtraction> {
      if (!text.trim() || text.length > 4000)
        throw new Error('UIE input must contain 1–4000 characters')
      if (!existsSync(options.pythonPath) || !existsSync(options.scriptPath) || !existsSync(modelWeights))
        throw new Error('Local UIE-base runtime or model is unavailable')
      const raw = await runPython(options, text)
      return parseUieOutput(text, raw)
    },
  }
}

async function runPython(options: LocalUieOptions, text: string): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const child = spawn(options.pythonPath, [options.scriptPath, '--home-path', options.modelHome], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error?: Error, value?: unknown) => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => {
      terminateChildTree()
      finish(new Error('Local UIE-base extraction timed out'))
    }, options.timeoutMs ?? 60_000)
    child.on('error', error => finish(error))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) {
        terminateChildTree()
        finish(new Error('Local UIE-base output is too large'))
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000)
    })
    child.on('close', code => {
      if (code !== 0) {
        finish(new Error(`Local UIE-base failed (${code ?? 'unknown'}): ${stderr.trim().slice(-500)}`))
        return
      }
      try { finish(undefined, JSON.parse(stdout)) }
      catch { finish(new Error('Local UIE-base returned invalid JSON')) }
    })
    child.stdin.on('error', error => finish(error))
    child.stdin.end(JSON.stringify({ text }))

    function terminateChildTree(): void {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true, stdio: 'ignore',
        })
        killer.on('error', () => child.kill())
      }
      else {
        child.kill()
      }
    }
  })
}

/** UIE offsets are Unicode code-point indices, not JavaScript UTF-16 offsets. */
export function parseUieOutput(source: string, raw: unknown): UieExtraction {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('UIE output must be an object')
  const chars = Array.from(source)
  const entities = new Map<string, UieMention>()
  const fields = new Map<string, UieMention>()
  const relations = new Map<string, UieRelation>()

  for (const [label, entries] of Object.entries(raw)) {
    if (!Array.isArray(entries))
      continue
    for (const entry of entries) {
      const subject = mention(chars, label, entry)
      if (!subject)
        continue
      const key = `${label}\u0000${subject.start}\u0000${subject.end}`
      if (ENTITY_LABELS.has(label)) putBest(entities, key, subject)
      if (FIELD_LABELS.has(label)) putBest(fields, key, subject)
      const nested = asRecord(entry)?.relations
      if (!nested || typeof nested !== 'object' || Array.isArray(nested))
        continue
      for (const [predicate, objects] of Object.entries(nested)) {
        if (!Array.isArray(objects) || !predicate.trim())
          continue
        for (const item of objects) {
          const object = mention(chars, predicate, item)
          if (!object)
            continue
          const relation: UieRelation = {
            subject,
            predicate,
            object,
            score: Math.min(subject.score, object.score),
          }
          const relationKey = `${subject.start}\u0000${subject.end}\u0000${predicate}\u0000${object.start}\u0000${object.end}`
          putBest(relations, relationKey, relation)
        }
      }
    }
  }
  return { model: 'uie-base', entities: [...entities.values()], fields: [...fields.values()], relations: [...relations.values()] }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function mention(chars: string[], label: string, raw: unknown): UieMention | undefined {
  const value = asRecord(raw)
  if (!value || typeof value.text !== 'string' || typeof value.start !== 'number'
    || typeof value.end !== 'number' || typeof value.probability !== 'number')
    return undefined
  const { start, end, probability } = value
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start
    || end > chars.length || !Number.isFinite(probability) || probability < 0 || probability > 1
    || chars.slice(start, end).join('') !== value.text)
    return undefined
  return { label, text: value.text, start, end, score: probability }
}

function putBest<T extends { score: number }>(items: Map<string, T>, key: string, item: T): void {
  if (!items.has(key) || items.get(key)!.score < item.score)
    items.set(key, item)
}

/** UIE-only information enters review, never the authoritative store automatically. */
export function uieReviewCandidates(source: string, extraction: UieExtraction): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = []
  for (const field of extraction.fields) {
    if (field.score < 0.75 || !isSelfField(source, field.label))
      continue
    const mapped = FIELD_MAPPINGS[field.label]
    if (!mapped)
      continue
    const content = `${mapped.title}：${field.text}`
    if (!isSafeMemoryContent(content))
      continue
    candidates.push({
      content,
      metadata: {
        kind: 'other', predicate: mapped.predicate, memoryKey: mapped.predicate,
        subjectId: 'owner:self', normalizedValue: field.text,
        confidence: field.score, importance: 0.6,
        extractionChannel: 'uie-base-local', extractorVersion: EXTRACTOR_VERSION,
        requiresReview: true, ...inferMemoryPrivacy(content),
      },
    })
  }
  for (const relation of extraction.relations) {
    if (relation.score < 0.75)
      continue
    const content = `${relation.subject.text}的${relation.predicate}：${relation.object.text}`
    if (!isSafeMemoryContent(content))
      continue
    candidates.push({
      content,
      metadata: {
        kind: 'other', predicate: `uie.${relation.predicate}`, subjectId: `entity:${relation.subject.text}`,
        normalizedValue: relation.object.text, cardinality: 'multiple',
        confidence: relation.score, importance: 0.55,
        extractionChannel: 'uie-base-local', extractorVersion: EXTRACTOR_VERSION,
        requiresReview: true, sensitivity: 'private', sharePolicy: 'local-only',
      },
    })
  }
  const unique = new Map<string, MemoryCandidate>()
  for (const candidate of candidates) {
    const key = candidate.content.toLocaleLowerCase()
    if (!unique.has(key))
      unique.set(key, candidate)
  }
  return [...unique.values()].slice(0, 8)
}

const FIELD_MAPPINGS: Record<string, { title: string; predicate: string }> = {
  姓名: { title: '用户姓名/名字', predicate: 'profile.name' },
  职业: { title: '用户职业', predicate: 'profile.occupation' },
  所在地: { title: '用户所在地', predicate: 'profile.location' },
  喜好: { title: '用户喜好/偏好', predicate: 'preference.like' },
  当前项目: { title: '用户当前项目', predicate: 'project.current' },
}

function isSelfField(source: string, label: string): boolean {
  switch (label) {
    case '姓名': return /(?:我叫|我的(?:名字|姓名)是)/u.test(source)
    case '职业': return /(?:我的职业是|我(?:是|在).{0,30}(?:担任|做|从事))/u.test(source)
    case '所在地': return /(?:我(?:现在|目前)?住在|我的(?:所在地|居住地)是)/u.test(source)
    case '喜好': return /我(?:最)?(?:喜欢|偏好|爱)/u.test(source)
    case '当前项目': return /我(?:正在|在|目前在)(?:做|开发|研究|推进)/u.test(source)
    default: return false
  }
}
