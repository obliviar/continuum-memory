import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createGraphExtractionRun, createGraphL1Store, createGraphL1Writer,
  createGraphPredicateRegistry, createGraphRelationTaskQueue, createGraphSemanticRepository,
  createMemoryV4Repository, normalizeGraphExtraction, assessGraphClaim,
  type GraphEntityRecordView } from '@continuum-memory/memory'
import { createLocalErlangshenNli, ERLANGSHEN_NLI_MODEL_ID,
  ERLANGSHEN_NLI_PREPROCESSING_VERSION } from './local-erlangshen-nli'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('local Erlangshen process adapter', () => {
  it('keeps one local process and validates the pinned model revision and probabilities', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'graph-nli-test-'))
    directories.push(directory)
    const scriptPath = join(directory, 'fake-nli.cjs')
    writeFileSync(scriptPath, `
      process.stdout.write(JSON.stringify({ready:true,modelId:${JSON.stringify(ERLANGSHEN_NLI_MODEL_ID)},
        modelRevision:'revision-1'})+'\\n');
      let buffer=''; process.stdin.on('data', chunk => { buffer += chunk;
        let i; while ((i=buffer.indexOf('\\n'))>=0) {
          const line=buffer.slice(0,i); buffer=buffer.slice(i+1);
          const request=JSON.parse(line); process.stdout.write(JSON.stringify({id:request.id,
            scores:{CONTRADICTION:0.1,NEUTRAL:0.2,ENTAILMENT:0.7},label:'ENTAILMENT',truncated:false,
            modelId:${JSON.stringify(ERLANGSHEN_NLI_MODEL_ID)},modelRevision:'revision-1'})+'\\n');
        }
      });
    `)
    const judge = createLocalErlangshenNli({ pythonPath: process.execPath, scriptPath,
      modelPath: directory, modelRevision: 'revision-1', startupTimeoutMs: 5000, requestTimeoutMs: 5000 })
    try {
      const request = { premise: { kind: 'claim' as const,
        ref: { kind: 'claim' as const, id: 'a', version: 1 }, text: '张三在星河公司工作。' },
      hypothesisText: '张三任职于星河公司。' }
      expect(await judge.judge(request)).toEqual({ ok: true, value: {
        scores: { CONTRADICTION: 0.1, NEUTRAL: 0.2, ENTAILMENT: 0.7 },
        modelId: ERLANGSHEN_NLI_MODEL_ID, modelRevision: 'revision-1',
        preprocessingVersion: ERLANGSHEN_NLI_PREPROCESSING_VERSION, truncated: false,
      } })
      expect((await judge.judge(request)).ok).toBe(true)
    }
    finally { judge.close() }
  })

  it.skipIf(!process.env.CONTINUUM_MEMORY_NLI_MODEL_PATH || !process.env.CONTINUUM_MEMORY_NLI_PYTHON)(
    'runs a Chinese pair through the installed offline 330M model', async () => {
      const modelPath = process.env.CONTINUUM_MEMORY_NLI_MODEL_PATH!
      const judge = createLocalErlangshenNli({
        pythonPath: process.env.CONTINUUM_MEMORY_NLI_PYTHON!,
        modelPath,
        dependenciesPath: process.env.CONTINUUM_MEMORY_NLI_DEPENDENCIES,
        scriptPath: join(dirname(fileURLToPath(import.meta.url)), '../../resources/erlangshen_nli.py'),
        modelRevision: modelPath.split(/[\\/]/).at(-1)!,
      })
      try {
        const result = await judge.judge({ premise: { kind: 'claim',
          ref: { kind: 'claim', id: 'source', version: 1 }, text: '张三在星河公司工作。' },
        hypothesisText: '张三任职于星河公司。' })
        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(Object.values(result.value.scores).reduce((sum, score) => sum + score, 0)).toBeCloseTo(1)
          expect(result.value.truncated).toBe(false)
        }
      }
      finally { judge.close() }
    }, 120_000)

  it.skipIf(!process.env.CONTINUUM_MEMORY_NLI_MODEL_PATH || !process.env.CONTINUUM_MEMORY_NLI_PYTHON)(
    'publishes two reviewed L1 Claims, judges their task, and reuses the persisted result', async () => {
      const modelPath = process.env.CONTINUUM_MEMORY_NLI_MODEL_PATH!
      const revision = modelPath.split(/[\\/]/).at(-1)!
      const judge = createLocalErlangshenNli({ pythonPath: process.env.CONTINUUM_MEMORY_NLI_PYTHON!,
        modelPath, modelRevision: revision, dependenciesPath: process.env.CONTINUUM_MEMORY_NLI_DEPENDENCIES,
        scriptPath: join(dirname(fileURLToPath(import.meta.url)), '../../resources/erlangshen_nli.py') })
      const storage = () => {
        let payload: string | undefined
        return { load: () => payload, save: (next: string) => { payload = next } }
      }
      const scope = { ownerId: 'test-owner', agentId: 'test-agent' }
      const entities: GraphEntityRecordView[] = [
        { ref: { kind: 'entity', id: 'zhang-san', version: 1 }, scope,
          entityType: 'person', canonicalName: '张三', aliases: [] },
        { ref: { kind: 'entity', id: 'xinghe', version: 1 }, scope,
          entityType: 'organization', canonicalName: '星河公司', aliases: [] },
      ]
      const v4 = createMemoryV4Repository({ now: () => 1_800_000_000_000 })
      const l1 = createGraphL1Store(storage())
      const registry = createGraphPredicateRegistry()
      const semantic = createGraphSemanticRepository(storage(), v4)
      const taskStorage = storage()
      const makeQueue = () => createGraphRelationTaskQueue(taskStorage,
        { modelId: ERLANGSHEN_NLI_MODEL_ID, modelRevision: revision,
          preprocessingVersion: ERLANGSHEN_NLI_PREPROCESSING_VERSION })
      const queue = makeQueue()
      const evidenceText = (claim: { provenance: { sources: readonly { episodeId: string;
        locator: { kind: string; start?: number; end?: number } }[] } }) => {
        const source = claim.provenance.sources[0]!
        const text = v4.snapshot().episodes.find(episode => episode.id === source.episodeId)?.content ?? ''
        return text.slice(source.locator.start, source.locator.end)
      }
      const writer = createGraphL1Writer(v4, l1, registry, scope, { syncFromClaims: async () => {
        const result = await semantic.syncFromClaims(l1, v4, registry, scope)
        if (!result.ok) throw new Error(result.error.message)
        const bundle = semantic.snapshot()!
        queue.sync(bundle.claims, bundle.predicates, scope, evidenceText)
      } })
      try {
        for (const [index, sentence, organizationStart] of [
          [1, '张三在星河公司工作。', 3], [2, '张三任职于星河公司。', 5],
        ] as const) {
          const run = createGraphExtractionRun({ sourceId: `message-${index}`, sourceText: sentence,
            modelId: 'uie-test', rawOutput: { graph: {
              entities: [
                { id: 'person', type: 'person', text: '张三', span: { start: 0, end: 2 }, modelScore: 0.95 },
                { id: 'org', type: 'organization', text: '星河公司',
                  span: { start: organizationStart, end: organizationStart + 4 }, modelScore: 0.95 },
              ],
              facts: [{ id: 'fact-1', subjectMentionId: 'person', predicate: 'works at',
                object: { mentionId: 'org' }, evidenceSpan: { start: 0, end: sentence.length }, modelScore: 0.95,
                context: { negation: { value: false, resolution: 'resolved' },
                  condition: { value: null, resolution: 'absent' },
                  time: { value: null, resolution: 'absent' },
                  speaker: { value: null, resolution: 'absent' } } }],
            } } })
          const fact = normalizeGraphExtraction(run, { entities, scope,
            explicitIdentityByMentionId: { person: 'zhang-san', org: 'xinghe' } }).facts[0]!
          const review = assessGraphClaim(run, fact,
            { sensitivity: 'private', sharePolicy: 'local-only' }, 1_800_000_000_000 + index)
          expect((await writer.submit(run, fact, review, entities))?.state).toBe('published')
        }
        expect(v4.snapshot().factVersions).toHaveLength(2)
        expect(semantic.snapshot()?.claims).toHaveLength(2)
        const task = queue.ready()[0]!
        expect(task).toBeDefined()
        const claims = semantic.snapshot()!.claims
        const premise = claims.find(claim => claim.ref.id === task.claims[0].id)!
        const hypothesis = claims.find(claim => claim.ref.id === task.claims[1].id)!
        const premiseText = evidenceText(premise)
        const hypothesisText = evidenceText(hypothesis)
        const response = await judge.judge({ premise: { kind: 'claim', ref: premise.ref, text: premiseText },
          hypothesisText })
        expect(response.ok).toBe(true)
        if (!response.ok) return
        const scores = response.value.scores
        const label = (Object.keys(scores) as Array<keyof typeof scores>)
          .reduce((best, next) => scores[next] > scores[best] ? next : best)
        queue.complete(task.key, { label, scores, truncated: response.value.truncated,
          premiseHash: createHash('sha256').update(premiseText).digest('hex'),
          hypothesisHash: createHash('sha256').update(hypothesisText).digest('hex'), evaluatedAt: Date.now() })
        expect(makeQueue().snapshot().find(item => item.key === task.key)).toMatchObject({
          status: 'completed', result: { scores, label },
        })
        await writer.retryPending()
        expect(makeQueue().snapshot()).toHaveLength(1)
        expect(makeQueue().ready()).toHaveLength(0)
      }
      finally { judge.close() }
    }, 120_000)
})
