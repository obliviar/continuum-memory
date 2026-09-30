import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createCaptureRepository, createEncryptedFilePersistence, createGraphExtractionResultStore,
  createGraphL1ProjectionRepository, createGraphL1Store, createGraphPredicateRegistry,
  createGraphSemanticRepository, createLocalUieExtractor, createMemoryV4Repository, createMemoryWriter,
  createUieRuleFallbackExtractor, createVectorStore, localUieScriptPath, projectOpenAssertions,
  searchOpenAssertions, uieGraphExtractionRun,
} from '@continuum-memory/memory'

describe('installed UIE open graph pipeline', () => {
  it.skipIf(!process.env.CONTINUUM_MEMORY_UIE_PYTHON || !process.env.CONTINUUM_MEMORY_UIE_MODEL_PATH)(
    'captures new domain events, reviews, navigates and reloads encrypted open assertions; dynamically resets UIE schema', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'continuum-open-graph-'))
      const disk = (name: string) => createEncryptedFilePersistence({ encryptedPath: join(directory, `${name}.enc`),
        keyPath: join(directory, `${name}.key`), protectKey: key => key, unprotectKey: key => key })
      const model = createLocalUieExtractor({ pythonPath: process.env.CONTINUUM_MEMORY_UIE_PYTHON!,
        modelPath: process.env.CONTINUUM_MEMORY_UIE_MODEL_PATH!, modelHome: '', scriptPath: localUieScriptPath, timeoutMs: 120_000 })
      const scope = { ownerId: 'open-e2e-owner', agentId: 'open-e2e-agent' }
      try {
        expect(model.isReady()).toBe(true)
        await model.extract('样品S7存放在恒温箱B2。')
        const captures = createCaptureRepository({ persistence: disk('captures') })
        const extractions = createGraphExtractionResultStore(disk('extractions'))
        const v4 = createMemoryV4Repository(), l1 = createGraphL1Store(disk('l1')), registry = createGraphPredicateRegistry()
        const semantic = createGraphSemanticRepository(disk('semantic'), v4, captures, extractions)
        const projection = createGraphL1ProjectionRepository(disk('projection'), semantic, v4, l1, captures, extractions)
        const extractor = createUieRuleFallbackExtractor({ uie: model, rules: () => [],
          onGraphExtraction: (_, run) => { extractions.append(run) } })
        const memory = createMemoryWriter({ store: createVectorStore(), captureRepository: captures, extractor })
        const text = '样品S7存放在恒温箱B2。恒温箱B2发生温控故障。'
        await memory.capture({ userMessage: text, assistantMessage: '', metadata: { sourceMessageIds: ['new-domain'] } }, scope)
        expect(extractions.list()[0]?.modelId).toBe('uie-base')
        const items = projectOpenAssertions(captures.snapshot(), extractions, scope)
          .filter(item => ['存放在', '发生'].includes(item.relationText))
        expect(items).toHaveLength(2)
        for (const item of items) extractions.recordOpenReview({ assertionId: item.ref.id,
          sourceId: item.extraction.sourceId, sourceRevision: item.extraction.sourceRevision,
          status: 'accepted', reason: '核对本地合成原文', reviewedAt: Date.now() })
        expect((await semantic.syncFromClaims(l1, v4, registry, scope)).ok).toBe(true)
        const view = projection.sync()!
        const hits = searchOpenAssertions(view.semanticBundle, '样品S7', { scope, maximumDepth: 2 })
        expect(hits.map(hit => hit.assertion.relationText)).toEqual(['存放在', '发生'])
        expect(hits[1]?.route).toBe('mention-text-candidate')
        expect(view.semanticBundle.claims).toHaveLength(0)
        expect(view.edges.filter(edge => edge.kind === 'open-participant')).toHaveLength(4)
        for (const file of ['captures', 'extractions', 'semantic', 'projection'])
          expect(readFileSync(join(directory, `${file}.enc`), 'utf8')).not.toContain('恒温箱B2')
        const reopenedCaptures = createCaptureRepository({ persistence: disk('captures') })
        const reopenedExtractions = createGraphExtractionResultStore(disk('extractions'))
        const reopenedSemantic = createGraphSemanticRepository(disk('semantic'), v4, reopenedCaptures, reopenedExtractions)
        const reopenedProjection = createGraphL1ProjectionRepository(disk('projection'), reopenedSemantic, v4, l1, reopenedCaptures, reopenedExtractions)
        expect(searchOpenAssertions(reopenedProjection.snapshot()!.semanticBundle, '样品S7', { scope })).toHaveLength(2)

        const customText = '设备名称是恒温箱B2，故障是温控失效。'
        const dynamic = await model.extract(customText, [{ 设备名称: ['故障'] }])
        expect(dynamic.entities.some(entity => entity.label === '设备名称')).toBe(true)
        expect(dynamic.relations.some(relation => relation.predicate === '故障')).toBe(true)
        const dynamicRun = uieGraphExtractionRun('custom', customText, dynamic)
        expect(dynamicRun.status).toBe('complete')
        expect(dynamicRun.entityMentions.some(mention => mention.type === '设备名称')).toBe(true)
        expect((dynamicRun.rawOutput as { extractionSchema: unknown }).extractionSchema).toEqual([{ 设备名称: ['故障'] }])
        captures.register({ userMessage: customText, assistantMessage: '', metadata: { sourceMessageIds: ['custom'] } }, scope, 'test')
        extractions.append(dynamicRun)
        const dynamicAssertion = projectOpenAssertions(captures.snapshot(), extractions, scope)
          .find(item => item.extraction.sourceId === 'custom' && item.relationText === '故障')!
        expect(dynamicAssertion).toBeDefined()
        extractions.recordOpenReview({ assertionId: dynamicAssertion.ref.id, sourceId: 'custom',
          sourceRevision: dynamicAssertion.extraction.sourceRevision, status: 'accepted', reason: '核对动态 UIE 原文', reviewedAt: Date.now() })
        expect((await semantic.syncFromClaims(l1, v4, registry, scope)).ok).toBe(true)
        expect(searchOpenAssertions(projection.sync()!.semanticBundle, '恒温箱B2', { scope })
          .some(hit => hit.assertion.relationText === '故障')).toBe(true)
        const restored = await model.extract('我喜欢图论课')
        expect(Object.keys(restored.rawOutput as object)).not.toContain('设备名称')
        expect(uieGraphExtractionRun('default', '我喜欢图论课', restored).factCandidates).toHaveLength(1)
      } finally { model.dispose(); rmSync(directory, { recursive: true, force: true }) }
    }, 240_000)
})
