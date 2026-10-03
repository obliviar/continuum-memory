import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MemoryCapture } from '@continuum-memory/contracts'
import { createGraphExtractionRun } from './graph-extraction-result'
import type { GraphExtractionRun } from './graph-extraction-result'
import { extractMemoryCandidates, inferMemoryPrivacy, isSafeMemoryContent } from './memory-extractor'
import type { MemoryCandidate, MemoryExtractor } from './memory-extractor'
import { personalUieRelations } from './uie-personal-relations'
import { extractLocalOpenAssertions } from './open-assertion-extractor'
import { planUieSchema } from './uie-schema-planner'

const ENTITY_LABELS = new Set([
  '人物', '地点', '组织机构', '项目', '企业', '影视作品', '图书作品',
  '歌曲', '历史人物', '学校', '国家', '行政区', '机构',
])
const FIELD_LABELS = new Set(['姓名', '职业', '所在地', '喜好', '当前项目', '爱好', '喜欢', '课程', '上课地点'])
const MAX_OUTPUT_BYTES = 2_000_000
const EXTRACTOR_VERSION = 'local-uie-base-v1'
const AUTO_REVIEW_VERSION = 'uie-grounded-assertion-v2'
const AUTO_REVIEW_SCORE = 0.85

const RELATION_CUES: Record<string, RegExp> = {
  居住地: /(?:居住地|住在|居住于|定居于)/u,
  所属组织: /(?:所属组织|属于|任职于|在.{0,24}(?:工作|任职))/u,
  董事长: /董事长/u,
  创始人: /创始人/u,
  总部地点: /(?:总部地点|总部位于)/u,
  毕业院校: /(?:毕业院校|毕业于)/u,
  国籍: /国籍/u,
  喜欢: /(?:喜欢|偏好|爱吃|爱喝|爱玩|爱打|爱看|爱听)/u,
  修读课程: /(?:选修|修读|学习|上(?=[^，。]{1,30}(?:课|学|课程)))/u,
  上课地点: /(?:上课|学习)/u,
  参与项目: /(?:正在(?:做|开发|研究|推进)|参与.{0,20}项目)/u,
}

function assertionClause(source: string, start: number, end: number): string | undefined {
  const chars = Array.from(source)
  if (start < 0 || end > chars.length || start >= end) return undefined
  let from = start
  while (from > 0 && !/[，,。！？!?；;\n]/u.test(chars[from - 1]!)) from--
  const tail = chars.slice(end).findIndex(char => /[，,。！？!?；;\n]/u.test(char))
  const to = tail < 0 ? chars.length : end + tail
  if (chars[to] && /[？?]/u.test(chars[to]!)) return undefined
  const clause = chars.slice(from, to).join('').trim()
  if (/[?？]|(?:如果|假如|假设|要是|可能|也许|或许|计划|打算|希望|将来|听说|据说|有人说|声称|传闻|据报道|不知道|不确定|猜测|怀疑|请问|询问|并非|没有|未曾|尚未|已不|不太|不再|不怎么|再也不|从不|并不|不(?:是|在|属于|住|居住|工作|担任|喜欢)|不要|别|例如|比如|假想|扮演|引用)/u.test(clause)
    || /(?:吗|么|是否|能否)$/u.test(clause)
    || /[“”"「」『』]/u.test(clause)) return undefined
  return clause
}

function groundedRelation(source: string, relation: UieRelation, minimumScore = AUTO_REVIEW_SCORE): boolean {
  if (relation.score < minimumScore) return false
  const start = Math.min(relation.subject.start, relation.object.start)
  const end = Math.max(relation.subject.end, relation.object.end)
  const clause = assertionClause(source, start, end)
  const cue = RELATION_CUES[relation.predicate]
  return !!clause && !!cue && cue.test(clause)
    && clause.includes(relation.subject.text) && clause.includes(relation.object.text)
    && !/(?:昨天|明天|今晚|上周|下周|每周|曾经|以前|目前|现在|未来|去年|今年|明年)/u.test(clause)
}

function relationEvidenceSpan(source: string, relation: UieRelation, minimumScore: number): { start: number; end: number } {
  const chars = Array.from(source)
  let start = Math.min(relation.subject.start, relation.object.start)
  let end = Math.max(relation.subject.end, relation.object.end)
  if (groundedRelation(source, relation, minimumScore)) {
    while (start > 0 && !/[，,。！？!?；;\n]/u.test(chars[start - 1]!)) start--
    while (end < chars.length && !/[，,。！？!?；;\n]/u.test(chars[end]!)) end++
  } else if (relation.evidenceSpan) {
    start = relation.evidenceSpan.start
    end = relation.evidenceSpan.end
  }
  return { start, end }
}

export type UieSchema = (string | { [entityLabel: string]: string[] })[]

export function parseUieExtractionTargets(input: string): UieSchema {
  if (typeof input !== 'string' || !input.trim() || input.length > 2000)
    throw new Error('请输入抽取目标，例如：样品→存放位置；设备→故障。')
  const schema = input.split(/[；;\n]/u).map(part => part.trim()).filter(Boolean).map(part => {
    const [label, ...relations] = part.split(/→|->/u).map(value => value.trim())
    if (relations.length > 1) throw new Error('每个抽取目标只能包含一个箭头。')
    return relations.length ? { [label!]: relations[0]!.split(/[、,，]/u).map(value => value.trim()).filter(Boolean) } : label!
  })
  validateUieSchema(schema)
  return schema
}

function validateUieSchema(schema: UieSchema): void {
  if (!Array.isArray(schema) || !schema.length || schema.length > 64) throw new Error('抽取目标数量必须为 1–64。')
  let count = 0
  for (const target of schema) {
    let labels: unknown[]
    if (typeof target === 'string') labels = [target]
    else if (target && typeof target === 'object' && Object.keys(target).length === 1) {
      const [label, children] = Object.entries(target)[0]!
      if (!Array.isArray(children) || !children.length || children.length > 32) throw new Error('每类关系目标必须为 1–32 个。')
      labels = [label, ...children]
    } else throw new Error('抽取目标格式无效。')
    if (labels.some(label => typeof label !== 'string' || !label.trim() || label.length > 100)) throw new Error('抽取目标名称必须为 1–100 字。')
    count += labels.length
  }
  if (count > 128) throw new Error('抽取目标总数不得超过 128。')
}

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
  /** Optional full-sentence evidence, in UIE code-point offsets, including context. */
  evidenceSpan?: { start: number; end: number }
}

export interface UieExtraction {
  model: 'uie-base'
  rawOutput: unknown
  entities: UieMention[]
  fields: UieMention[]
  relations: UieRelation[]
  schema?: UieSchema
}

export interface LocalUieOptions {
  pythonPath: string
  modelHome: string
  /** Direct local Taskflow checkpoint directory, when it is not under modelHome/taskflow. */
  modelPath?: string
  scriptPath: string
  timeoutMs?: number
  schema?: UieSchema
}

/** The source-tree bridge is shared by CLI, server and MCP; desktop packages it as an extra resource. */
export const localUieScriptPath = fileURLToPath(new URL('../../resources/uie_extract.py', import.meta.url))

export function createLocalUieFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): ReturnType<typeof createLocalUieExtractor> {
  const windowsDefault = process.platform === 'win32'
  return createLocalUieExtractor({
    pythonPath: environment.CONTINUUM_MEMORY_UIE_PYTHON
      || (windowsDefault ? 'D:\\Models\\UIE-mini\\.venv-paddle\\Scripts\\python.exe' : ''),
    modelHome: environment.CONTINUUM_MEMORY_UIE_MODEL_HOME
      || (windowsDefault ? 'D:\\Models\\UIE-mini' : ''),
    modelPath: environment.CONTINUUM_MEMORY_UIE_MODEL_PATH || undefined,
    scriptPath: environment.CONTINUUM_MEMORY_UIE_SCRIPT_PATH || localUieScriptPath,
  })
}

export interface UieRuleFallbackOptions {
  uie: Pick<ReturnType<typeof createLocalUieExtractor>, 'extract'>
  rules?: MemoryExtractor
  onGraphExtraction?: (turn: MemoryCapture, run: GraphExtractionRun) => void | Promise<void>
  onError?: (error: unknown) => void
  adaptiveSchema?: boolean
}

/** Keep rules authoritative; UIE contributes review-only candidates and never blocks capture. */
export function createUieRuleFallbackExtractor(options: UieRuleFallbackOptions): MemoryExtractor {
  const rules = options.rules ?? extractMemoryCandidates
  return async turn => {
    const local = await rules(turn)
    let extracted = false
    try {
      const extraction = await options.uie.extract(turn.userMessage,
        options.adaptiveSchema ? planUieSchema(turn.userMessage).schema : undefined)
      extracted = true
      if (options.onGraphExtraction) {
        const sourceIds = turn.metadata?.sourceMessageIds
        const sourceId = Array.isArray(sourceIds) && typeof sourceIds[0] === 'string'
          ? sourceIds[0] : String(turn.metadata?.memoryCaptureId ?? 'unknown-source')
        await options.onGraphExtraction(turn, uieGraphExtractionRun(sourceId, turn.userMessage, extraction))
      }
      const existing = new Set(local.map(candidate => candidate.content.toLocaleLowerCase()))
      return [...local, ...uieReviewCandidates(turn.userMessage, extraction)
        .filter(candidate => !existing.has(candidate.content.toLocaleLowerCase()))]
    }
    catch (error) {
      try { options.onError?.(error) }
      catch { /* Logging must not replace the rules fallback. */ }
      if (!extracted && options.onGraphExtraction) {
        const discovery = extractLocalOpenAssertions(turn.userMessage)
        const sourceIds = turn.metadata?.sourceMessageIds
        const sourceId = Array.isArray(sourceIds) && typeof sourceIds[0] === 'string'
          ? sourceIds[0] : String(turn.metadata?.memoryCaptureId ?? 'unknown-source')
        try {
          await options.onGraphExtraction(turn, createGraphExtractionRun({ sourceId, sourceText: turn.userMessage,
            modelId: 'local-open-patterns-v1', rawOutput: { graph: { ...discovery, facts: [] } } }))
        } catch { /* Source capture and stable rule memories survive a graph storage failure. */ }
      }
      return local
    }
  }
}

export function createLocalUieExtractor(options: LocalUieOptions) {
  const modelWeights = options.modelPath
    ? join(options.modelPath, 'model_state.pdparams')
    : join(options.modelHome, 'taskflow', 'information_extraction', 'uie-base', 'model_state.pdparams')
  let worker: ChildProcessWithoutNullStreams | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let pending: Promise<void> = Promise.resolve()
  let disposed = false

  function stopWorker(child: ChildProcessWithoutNullStreams): void {
    if (worker === child) worker = undefined
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore',
      })
      killer.on('error', () => child.kill())
      killer.on('close', code => { if (code !== 0 && child.exitCode === null) child.kill() })
    }
    else child.kill()
  }

  function scheduleIdleStop(child: ChildProcessWithoutNullStreams): void {
    idleTimer = setTimeout(() => {
      if (worker === child) stopWorker(child)
    }, 5 * 60_000)
    idleTimer.unref()
  }

  function runPython(text: string, schema?: UieSchema): Promise<unknown> {
    if (disposed) return Promise.reject(new Error('Local UIE-base extractor is closed'))
    return new Promise((resolve, reject) => {
      if (idleTimer) clearTimeout(idleTimer)
      let child = worker
      if (!child || child.killed || child.exitCode !== null || child.stdin.destroyed) {
        child = spawn(options.pythonPath, [options.scriptPath, '--serve',
          ...(options.modelPath ? ['--model-path', options.modelPath] : ['--home-path', options.modelHome])], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        })
        worker = child
        child.on('error', () => { /* An active request handles this; otherwise avoid an unhandled event. */ })
        child.stdin.on('error', () => { /* The request write callback reports pipe failures. */ })
        child.on('close', () => { if (worker === child) worker = undefined })
      }
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.stdout.off('data', onData)
        child.stderr.off('data', onStderr)
        child.off('error', onError)
        child.off('close', onClose)
        if (error) {
          stopWorker(child)
          reject(error)
        }
        else {
          scheduleIdleStop(child)
          resolve(value)
        }
      }
      const onData = (chunk: string) => {
        stdout += chunk
        if (Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) {
          finish(new Error('Local UIE-base output is too large'))
          return
        }
        const end = stdout.indexOf('\n')
        if (end < 0) return
        try {
          const response = JSON.parse(stdout.slice(0, end)) as { ok?: boolean; result?: unknown; error?: unknown }
          if (response.ok === true) finish(undefined, response.result)
          else finish(new Error(`Local UIE-base failed: ${String(response.error ?? 'unknown error')}`))
        }
        catch { finish(new Error('Local UIE-base returned invalid JSON')) }
      }
      const onStderr = (chunk: string) => { stderr = (stderr + chunk).slice(-4000) }
      const onError = (error: Error) => finish(error)
      const onClose = (code: number | null) =>
        finish(new Error(`Local UIE-base failed (${code ?? 'unknown'}): ${stderr.trim().slice(-500)}`))
      const timer = setTimeout(() => finish(new Error('Local UIE-base extraction timed out')),
        options.timeoutMs ?? 60_000)
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', onData)
      child.stderr.on('data', onStderr)
      child.on('error', onError)
      child.on('close', onClose)
      try { child.stdin.write(`${JSON.stringify({ text, ...(schema ? { schema } : {}) })}\n`, error => { if (error) finish(error) }) }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
    })
  }

  return {
    isReady: () => existsSync(options.pythonPath) && existsSync(options.scriptPath) && existsSync(modelWeights),
    async extract(text: string, schema: UieSchema | undefined = options.schema): Promise<UieExtraction> {
      if (disposed) throw new Error('Local UIE-base extractor is closed')
      if (!text.trim() || text.length > 4000)
        throw new Error('UIE input must contain 1–4000 characters')
      if (schema !== undefined) validateUieSchema(schema)
      const requestSchema = schema === undefined ? undefined : structuredClone(schema)
      if (!existsSync(options.pythonPath) || !existsSync(options.scriptPath) || !existsSync(modelWeights))
        throw new Error('Local UIE-base runtime or model is unavailable')
      const task = pending.then(() => runPython(text, requestSchema))
      pending = task.then(() => {}, () => {})
      const raw = await task
      return { ...parseUieOutput(text, raw), ...(requestSchema ? { schema: requestSchema } : {}) }
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      if (idleTimer) clearTimeout(idleTimer)
      if (worker) {
        worker.kill()
        stopWorker(worker)
      }
    },
  }
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
      // Unknown runtime schema labels remain type proposals instead of being discarded.
      if (ENTITY_LABELS.has(label) || !FIELD_LABELS.has(label)) putBest(entities, key, subject)
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
  return { model: 'uie-base', rawOutput: raw, entities: [...entities.values()], fields: [...fields.values()], relations: [...relations.values()] }
}

/** Preserve the untouched UIE payload, then convert code-point offsets for graph review. */
export function uieGraphExtractionRun(sourceId: string, sourceText: string, extraction: UieExtraction): GraphExtractionRun {
  const discovery = extractLocalOpenAssertions(sourceText)
  const personalRelations = personalUieRelations(sourceText, extraction.fields)
  const relations = [...extraction.relations, ...personalRelations]
  const spans = new Map<string, UieMention>()
  const add = (mention: UieMention) => {
    const key = `${mention.start}:${mention.end}`
    const previous = spans.get(key)
    if (!previous || (entityType(previous.label) === previous.label && entityType(mention.label) !== mention.label))
      spans.set(key, mention)
  }
  for (const mention of [...extraction.entities, ...extraction.fields]) add(mention)
  for (const relation of extraction.relations) {
    add(relation.subject)
    if (!literalType(relation.predicate)) add(relation.object)
  }
  const mentionId = (mention: UieMention) => `uie:${mention.start}:${mention.end}`
  const utf16 = (offset: number) => Array.from(sourceText).slice(0, offset).join('').length
  const entities = [...spans.values()].map(mention => ({ id: mentionId(mention), type: entityType(mention.label),
    text: mention.text, span: { start: utf16(mention.start), end: utf16(mention.end) }, modelScore: mention.score }))
  // UIE can label one span both a course and an interest. Keep the contextual
  // type proposal separate, so an unrelated root label cannot make it unreviewable.
  const personalMentionId = (mention: UieMention) => `uie-personal:${entityType(mention.label)}:${mention.start}:${mention.end}`
  for (const relation of personalRelations) {
    for (const mention of [relation.subject, ...(literalType(relation.predicate) ? [] : [relation.object])]) {
      const id = personalMentionId(mention)
      if (!entities.some(item => item.id === id)) entities.push({ id, type: entityType(mention.label),
        text: mention.text, span: { start: utf16(mention.start), end: utf16(mention.end) }, modelScore: mention.score })
    }
  }
  const facts = relations.map((relation, index) => {
    // Graph source records are not confidence-certified facts. Confidence remains
    // attached, but must not prevent independent reading of explicit source context.
    const minimumScore = 0
    const evidence = relationEvidenceSpan(sourceText, relation, minimumScore)
    return {
    id: `uie-fact:${index}`, subjectMentionId: index < extraction.relations.length
      ? mentionId(relation.subject) : personalMentionId(relation.subject), predicate: relation.predicate,
    object: literalType(relation.predicate)
      ? { literal: relation.object.text, valueType: literalType(relation.predicate) }
      : { mentionId: index < extraction.relations.length ? mentionId(relation.object) : personalMentionId(relation.object) },
    evidenceSpan: { start: utf16(evidence.start), end: utf16(evidence.end) },
    modelScore: relation.score,
    context: groundedRelation(sourceText, relation, minimumScore)
      ? { negation: { value: false, resolution: 'resolved' }, condition: { value: null, resolution: 'absent' },
          time: { value: null, resolution: 'absent' }, speaker: { value: 'user', resolution: 'resolved' } }
      : { negation: { value: null, resolution: 'unresolved' }, condition: { value: null, resolution: 'unresolved' },
          time: { value: null, resolution: 'unresolved' }, speaker: { value: null, resolution: 'unresolved' } },
  } })
  return createGraphExtractionRun({ sourceId, sourceText, modelId: extraction.model,
    rawOutput: { graph: { entities: [...entities, ...discovery.entities], facts, assertions: discovery.assertions }, uieRawOutput: extraction.rawOutput,
      extractionSchema: extraction.schema ?? null, adapterVersion: 'uie-open-assertions-v1' } })
}

/** Re-assess derived context from retained raw UIE without changing the immutable extraction record. */
export function refreshUieGraphReviewContext(run: GraphExtractionRun): GraphExtractionRun | undefined {
  if (run.modelId !== 'uie-base' || run.status !== 'complete') return undefined
  const envelope = asRecord(run.rawOutput)
  const raw = envelope?.uieRawOutput
  if (!raw) return undefined
  let rebuilt: GraphExtractionRun
  try { rebuilt = uieGraphExtractionRun(run.sourceId, run.sourceText, parseUieOutput(run.sourceText, raw)) }
  catch { return undefined }
  const sameObject = (a: typeof run.factCandidates[number]['object'], b: typeof a) => JSON.stringify(a) === JSON.stringify(b)
  if (rebuilt.status !== 'complete' || rebuilt.sourceRevision !== run.sourceRevision
    || rebuilt.factCandidates.length !== run.factCandidates.length
    || rebuilt.entityMentions.length !== run.entityMentions.length
    || !rebuilt.factCandidates.every((fact, index) => {
      const prior = run.factCandidates[index]
      return prior && fact.id === prior.id && fact.subjectMentionId === prior.subjectMentionId
        && fact.predicate === prior.predicate && fact.modelScore === prior.modelScore
        && sameObject(fact.object, prior.object)
    })
    || !rebuilt.entityMentions.every((mention, index) => {
      const prior = run.entityMentions[index]
      return prior && mention.id === prior.id && mention.type === prior.type && mention.text === prior.text
        && mention.span.start === prior.span.start && mention.span.end === prior.span.end
    })) return undefined
  return { ...run, factCandidates: rebuilt.factCandidates }
}

function entityType(label: string): string {
  if (['人物', '历史人物', '父亲', '母亲', '丈夫', '妻子', '主演', '导演', '作者', '歌手', '作词', '作曲', '董事长', '创始人', '校长'].includes(label)) return 'person'
  if (['组织机构', '机构', '企业', '学校', '所属组织', '毕业院校', '出品公司'].includes(label)) return 'organization'
  if (['地点', '国家', '行政区', '总部地点', '国籍', '居住地'].includes(label)) return 'location'
  if (label === '影视作品') return 'film'
  if (label === '图书作品') return 'book'
  if (label === '歌曲' || label === '主题曲') return 'song'
  if (label === '所属专辑') return 'album'
  if (label === '课程') return 'course'
  if (label === '兴趣') return 'interest'
  if (label === '项目' || label === '当前项目') return 'project'
  return label
}

function literalType(label: string): 'string' | 'number' | 'date' | undefined {
  if (['上映时间', '成立日期'].includes(label)) return 'date'
  if (['票房', '人口数量'].includes(label)) return 'number'
  if (['官方语言', '朝代', '姓名', '职业'].includes(label)) return 'string'
  return undefined
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

/** Only high-confidence, explicitly grounded, low-risk UIE assertions may bypass manual review. */
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
    const fieldClause = assertionClause(source, field.start, field.end)
    const autoEligible = field.score >= AUTO_REVIEW_SCORE && !!fieldClause && isSelfField(fieldClause, field.label)
      && !/(?:昨天|明天|今晚|上周|下周|每周|曾经|以前|未来|去年|明年)/u.test(fieldClause)
    candidates.push({
      content,
      metadata: {
        kind: 'other', predicate: mapped.predicate, memoryKey: mapped.predicate,
        subjectId: 'owner:self', normalizedValue: field.text,
        confidence: field.score, importance: 0.6,
        extractionChannel: 'uie-base-local', extractorVersion: EXTRACTOR_VERSION,
        requiresReview: !autoEligible, autoReviewPolicy: autoEligible ? AUTO_REVIEW_VERSION : undefined,
        ...inferMemoryPrivacy(content),
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
        requiresReview: !groundedRelation(source, relation),
        autoReviewPolicy: groundedRelation(source, relation) ? AUTO_REVIEW_VERSION : undefined,
        sensitivity: 'private', sharePolicy: 'local-only',
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
