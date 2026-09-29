import { describe, expect, it } from 'vitest'
import { createCaptureRepository } from '../../long-term/capture-repository'
import { createMemoryWriter } from '../../long-term/memory-writer'
import { createVectorStore } from '../../long-term/vector-store'
import { createGraphL1Store } from '../../long-term/graph-l1-write'
import { createGraphPredicateRegistry } from '../../long-term/graph-identity-normalization'
import { createLocalUieExtractor, createUieRuleFallbackExtractor, localUieScriptPath,
  parseUieOutput, uieGraphExtractionRun } from '../../long-term/local-uie'
import { createMemoryV4Repository } from '../../v4/repository/memory-v4-repository'
import { createGraphSemanticRepository } from './semantic-repository'
import { createGraphL1ProjectionRepository } from './l1-projection-repository'

function disk() {
  let payload: string | undefined
  return { load: () => payload, save: (value: string) => { payload = value } }
}
const scope = { ownerId: 'owner', agentId: 'agent' }

describe('source-grounded information graph', () => {
  it('publishes an unknown-schema utterance with zero extractor candidates, survives restart and revokes on source deletion', async () => {
    const sourceDisk = disk(), semanticDisk = disk(), projectionDisk = disk()
    const captures = createCaptureRepository({ persistence: sourceDisk })
    const v4 = createMemoryV4Repository()
    const l1 = createGraphL1Store(disk())
    const registry = createGraphPredicateRegistry()
    const semantic = createGraphSemanticRepository(semanticDisk, v4, captures)
    const projection = createGraphL1ProjectionRepository(projectionDisk, semantic, v4, l1, captures)
    const text = '双臂电桥实验失败，因为接线松动'
    const graphRun = uieGraphExtractionRun('m1', text, parseUieOutput(text, {}))
    expect(graphRun.factCandidates).toHaveLength(0)
    const writer = createMemoryWriter({ store: createVectorStore(), captureRepository: captures,
      extractor: () => [], onCaptureSourcesChanged: () => { void semantic.syncFromClaims(l1, v4, registry, scope).then(() => projection.sync()) } })
    expect(await writer.capture({ userMessage: text, assistantMessage: '', metadata: { sourceMessageIds: ['m1'] } }, scope)).toBe(0)
    await semantic.syncFromClaims(l1, v4, registry, scope)
    const view = projection.sync()!
    expect(view.semanticBundle.information).toHaveLength(1)
    expect(view.semanticBundle.information![0]).toMatchObject({ content: text, status: 'source-only',
      sharePolicy: 'local-only', source: { captureId: captures.snapshot().sources[0]!.id } })
    expect(view.semanticBundle.claims).toHaveLength(0)
    expect(v4.snapshot().facts).toHaveLength(0)

    const reopenedCaptures = createCaptureRepository({ persistence: sourceDisk })
    const reopenedSemantic = createGraphSemanticRepository(semanticDisk, v4, reopenedCaptures)
    const reopened = createGraphL1ProjectionRepository(projectionDisk, reopenedSemantic, v4, l1, reopenedCaptures)
    expect(reopened.snapshot()?.semanticBundle.information?.[0]?.content).toBe(text)
    reopenedCaptures.register({ userMessage: '双臂电桥实验改为重新接线', assistantMessage: '',
      metadata: { sourceMessageIds: ['m1'] } }, scope, 'test-v1')
    expect(reopened.snapshot()).toBeUndefined()
    expect((await reopenedSemantic.syncFromClaims(l1, v4, registry, scope)).ok).toBe(true)
    expect(reopened.sync()?.semanticBundle.information?.map(item => item.content))
      .toEqual(['双臂电桥实验改为重新接线'])
    reopenedCaptures.invalidate(scope, ['m1'])
    expect(reopened.snapshot()).toBeUndefined()
    const synced = await reopenedSemantic.syncFromClaims(l1, v4, registry, scope)
    expect(synced.ok).toBe(true)
    expect(reopened.sync()?.semanticBundle.information).toHaveLength(0)
    expect(projectionDisk.load()).not.toContain(text)
  })
  it('clears graph information when the memory writer clears its source inbox', async () => {
    const captures = createCaptureRepository({ persistence: disk() })
    const v4 = createMemoryV4Repository(), l1 = createGraphL1Store(disk())
    const registry = createGraphPredicateRegistry()
    const semantic = createGraphSemanticRepository(disk(), v4, captures)
    const projection = createGraphL1ProjectionRepository(disk(), semantic, v4, l1, captures)
    const writer = createMemoryWriter({ store: createVectorStore(), captureRepository: captures,
      extractor: () => [], onCaptureSourcesChanged: () => { void semantic.syncFromClaims(l1, v4, registry, scope).then(() => projection.sync()) } })
    await writer.capture({ userMessage: '实验记录', assistantMessage: '', metadata: { sourceMessageIds: ['m2'] } }, scope)
    await semantic.syncFromClaims(l1, v4, registry, scope)
    expect(projection.sync()?.semanticBundle.information).toHaveLength(1)
    await writer.clear(scope)
    expect(projection.snapshot()?.semanticBundle.information?.some(item => item.content === '实验记录')).not.toBe(true)
    await semantic.syncFromClaims(l1, v4, registry, scope)
    expect(projection.sync()?.semanticBundle.information).toHaveLength(0)
  })
  it.skipIf(!process.env.CONTINUUM_MEMORY_UIE_PYTHON || !process.env.CONTINUUM_MEMORY_UIE_MODEL_PATH)(
    'runs the installed UIE-base through capture and still publishes a schema-unknown utterance', async () => {
      const model = createLocalUieExtractor({ pythonPath: process.env.CONTINUUM_MEMORY_UIE_PYTHON!,
        modelPath: process.env.CONTINUUM_MEMORY_UIE_MODEL_PATH!, modelHome: '', scriptPath: localUieScriptPath,
        timeoutMs: 120_000 })
      try {
        const captures = createCaptureRepository({ persistence: disk() })
        const v4 = createMemoryV4Repository(), l1 = createGraphL1Store(disk())
        const registry = createGraphPredicateRegistry()
        const semantic = createGraphSemanticRepository(disk(), v4, captures)
        const projection = createGraphL1ProjectionRepository(disk(), semantic, v4, l1, captures)
        const runs: ReturnType<typeof uieGraphExtractionRun>[] = []
        const extractor = createUieRuleFallbackExtractor({ uie: model, rules: () => [],
          onGraphExtraction: (_, run) => { runs.push(run) } })
        const writer = createMemoryWriter({ store: createVectorStore(), captureRepository: captures,
          extractor, onCaptureSourcesChanged: () => { void semantic.syncFromClaims(l1, v4, registry, scope)
            .then(() => projection.sync()) } })
        const text = '双臂电桥实验失败，因为接线松动'
        await writer.capture({ userMessage: text, assistantMessage: '', metadata: { sourceMessageIds: ['uie-m1'] } }, scope)
        expect(runs).toHaveLength(1)
        expect(runs[0]?.factCandidates).toHaveLength(0)
        expect((await semantic.syncFromClaims(l1, v4, registry, scope)).ok).toBe(true)
        expect(projection.sync()?.semanticBundle.information?.map(item => item.content)).toEqual([text])
        expect(projection.snapshot()?.semanticBundle.claims).toHaveLength(0)
      } finally { model.dispose() }
    }, 150_000)
})
