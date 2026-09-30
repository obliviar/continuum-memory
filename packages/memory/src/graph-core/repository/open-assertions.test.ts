import { describe, expect, it } from 'vitest'
import { createCaptureRepository } from '../../long-term/capture-repository'
import { createGraphExtractionResultStore, createGraphExtractionRun } from '../../long-term/graph-extraction-result'
import { createGraphL1Store } from '../../long-term/graph-l1-write'
import { createGraphPredicateRegistry } from '../../long-term/graph-identity-normalization'
import { createUieRuleFallbackExtractor, parseUieOutput, uieGraphExtractionRun } from '../../long-term/local-uie'
import { createMemoryV4Repository } from '../../v4/repository/memory-v4-repository'
import { createGraphSemanticRepository } from './semantic-repository'
import { createGraphL1ProjectionRepository } from './l1-projection-repository'
import { projectOpenAssertions, searchOpenAssertions } from './open-assertions'

function disk() {
  let value: string | undefined
  return { load: () => value, save: (next: string) => { value = next } }
}
const scope = { ownerId: 'owner', agentId: 'agent' }

function fixture() {
  const captureDisk = disk(), extractionDisk = disk(), semanticDisk = disk(), projectionDisk = disk()
  const captures = createCaptureRepository({ persistence: captureDisk })
  const extractions = createGraphExtractionResultStore(extractionDisk)
  const v4 = createMemoryV4Repository(), l1 = createGraphL1Store(disk()), registry = createGraphPredicateRegistry()
  const semantic = createGraphSemanticRepository(semanticDisk, v4, captures, extractions)
  const projection = createGraphL1ProjectionRepository(projectionDisk, semantic, v4, l1, captures, extractions)
  const append = (text: string, id: string) => {
    captures.register({ userMessage: text, assistantMessage: '', metadata: { sourceMessageIds: [id] } }, scope, 'test')
    const run = uieGraphExtractionRun(id, text, parseUieOutput(text, {}))
    extractions.append(run)
    return run
  }
  const accept = (id: string) => {
    const assertion = projectOpenAssertions(captures.snapshot(), extractions, scope).find(item => item.ref.id === id)!
    extractions.recordOpenReview({ assertionId: id, sourceId: assertion.extraction.sourceId,
      sourceRevision: assertion.extraction.sourceRevision, status: 'accepted', reason: '忠实于原文', reviewedAt: 100 })
  }
  const sync = async () => {
    expect((await semantic.syncFromClaims(l1, v4, registry, scope)).ok).toBe(true)
    return projection.sync()!
  }
  return { captures, extractions, v4, l1, registry, semantic, projection, append, accept, sync,
    captureDisk, extractionDisk, semanticDisk, projectionDisk }
}

describe('schema-independent assertion publication and navigation', () => {
  it('retains unknown UIE labels and publishes an unknown relation without adding a native Claim', async () => {
    const f = fixture(), text = '样品S7保管于恒温箱B2'
    f.captures.register({ userMessage: text, assistantMessage: '', metadata: { sourceMessageIds: ['m1'] } }, scope, 'test')
    const parsed = parseUieOutput(text, { 样品: [{ text: '样品S7', start: 0, end: 4, probability: 0.95,
      relations: { 保管于: [{ text: '恒温箱B2', start: 7, end: 12, probability: 0.9 }] } }] })
    expect(parsed.entities[0]?.label).toBe('样品')
    f.extractions.append(uieGraphExtractionRun('m1', text, parsed))
    const pending = (await f.sync()).semanticBundle.openAssertions![0]!
    expect(pending).toMatchObject({ relationText: '保管于', review: { status: 'candidate' }, inferenceAllowed: false, sharePolicy: 'local-only' })
    expect(searchOpenAssertions(f.semantic.snapshot()!, '样品S7', { scope })).toEqual([])
    f.accept(pending.ref.id)
    expect(f.projection.snapshot()).toBeUndefined()
    const view = await f.sync()
    expect(view.edges.filter(edge => edge.kind === 'open-participant')).toHaveLength(2)
    expect(view.edges.filter(edge => edge.kind === 'open-evidence')).toHaveLength(1)
    expect(searchOpenAssertions(view.semanticBundle, '样品S7', { scope })).toHaveLength(1)
    expect(view.semanticBundle.claims).toEqual([])
    expect(f.v4.snapshot().facts).toEqual([])
    expect(view.proofs).toEqual([])
  })

  it('preserves a three-participant event and resumes the same review after repeated extraction and restart', async () => {
    const f = fixture(), text = '我把样品 S7放入恒温箱 B2。'
    f.append(text, 'm1')
    const item = (await f.sync()).semanticBundle.openAssertions![0]!
    expect(item.participants.map(participant => participant.role)).toEqual(['agent', 'theme', 'destination'])
    expect(item.participants.map(participant => participant.text)).toEqual(['我', '样品 S7', '恒温箱 B2'])
    expect(item.context.negation.resolution).toBe('unresolved')
    f.accept(item.ref.id)
    f.append(text, 'm1')
    const view = await f.sync()
    expect(view.semanticBundle.openAssertions).toHaveLength(1)
    expect(view.semanticBundle.openAssertions![0]?.review.status).toBe('accepted')
    const captures = createCaptureRepository({ persistence: f.captureDisk })
    const extractions = createGraphExtractionResultStore(f.extractionDisk)
    const semantic = createGraphSemanticRepository(f.semanticDisk, f.v4, captures, extractions)
    const reopened = createGraphL1ProjectionRepository(f.projectionDisk, semantic, f.v4, f.l1, captures, extractions)
    expect(reopened.snapshot()?.semanticBundle.openAssertions![0]?.review.status).toBe('accepted')
  })

  it('retrieves related records through mention text without merging identities or producing a conclusion', async () => {
    const f = fixture()
    f.append('样品 S7存放在恒温箱 B2。', 'm1')
    f.append('恒温箱 B2发生故障。', 'm2')
    for (const item of projectOpenAssertions(f.captures.snapshot(), f.extractions, scope)) f.accept(item.ref.id)
    const view = await f.sync()
    const hits = searchOpenAssertions(view.semanticBundle, '样品 S7', { scope, maximumDepth: 2 })
    expect(hits).toHaveLength(2)
    expect(hits[1]).toMatchObject({ depth: 1, route: 'mention-text-candidate', via: { mentionText: '恒温箱 B2' } })
    const boxMentions = view.semanticBundle.openAssertions!.flatMap(item => item.participants.filter(p => p.text === '恒温箱 B2'))
    expect(new Set(boxMentions.map(mention => mention.ref.id)).size).toBe(2)
    expect(searchOpenAssertions(view.semanticBundle, '样品 S7', { scope, maximumDepth: 0 })).toHaveLength(1)
    expect(searchOpenAssertions(view.semanticBundle, '样品 S7', { scope, limit: 1 })).toHaveLength(1)
    expect(searchOpenAssertions(view.semanticBundle, '样品 S7', { scope: { ...scope, ownerId: 'other' } })).toEqual([])
    expect(view.derivedClaims).toEqual([])
  })

  it('invalidates the view immediately on source replacement, removal and review revocation', async () => {
    const f = fixture()
    f.append('样品 S7存放在恒温箱 B2。', 'm1')
    const item = (await f.sync()).semanticBundle.openAssertions![0]!
    f.accept(item.ref.id)
    await f.sync()
    f.extractions.recordOpenReview({ assertionId: item.ref.id, sourceId: item.extraction.sourceId,
      sourceRevision: item.extraction.sourceRevision, status: 'rejected', reason: '撤销', reviewedAt: 101 })
    expect(f.projection.snapshot()).toBeUndefined()
    expect(searchOpenAssertions((await f.sync()).semanticBundle, '样品 S7', { scope })).toEqual([])
    f.captures.register({ userMessage: '样品 S7存放在新柜 C3。', assistantMessage: '',
      metadata: { sourceMessageIds: ['m1'] } }, scope, 'test')
    expect(f.projection.snapshot()).toBeUndefined()
    expect((await f.sync()).semanticBundle.openAssertions).toEqual([])
    f.captures.invalidate(scope, ['m1'])
    expect((await f.sync()).semanticBundle.information).toEqual([])
  })

  it('does not let a known predicate reject a new object type from the open representation', async () => {
    const f = fixture(), text = '我喜欢仪器M3'
    f.captures.register({ userMessage: text, assistantMessage: '', metadata: { sourceMessageIds: ['m1'] } }, scope, 'test')
    f.extractions.append(createGraphExtractionRun({ sourceId: 'm1', sourceText: text, modelId: 'fixture',
      rawOutput: { graph: { entities: [
        { id: 'p', type: 'person', text: '我', span: { start: 0, end: 1 }, modelScore: 0.9 },
        { id: 'x', type: 'instrument', text: '仪器M3', span: { start: 3, end: 7 }, modelScore: 0.9 }],
      facts: [{ id: 'f', subjectMentionId: 'p', predicate: '喜欢', object: { mentionId: 'x' }, evidenceSpan: { start: 0, end: 7 }, modelScore: 0.9 }] } } }))
    expect((await f.sync()).semanticBundle.openAssertions![0]?.participants[1]?.typeCandidate).toBe('instrument')
  })

  it('rejects stale or fabricated evidence and forgery of a published bundle', async () => {
    const f = fixture()
    const run = f.append('样品 S7存放在恒温箱 B2。', 'm1')
    run.sourceRevision = '0'.repeat(64)
    f.extractions.clear(); f.extractions.append(run)
    expect((await f.sync()).semanticBundle.openAssertions).toEqual([])
    const bundle = f.semantic.snapshot()!
    const forged = { ...bundle, bundleId: 'forged', openAssertions: [{ text: 'fabricated' }] }
    const result = await f.semantic.publish({ operationId: 'forged', expectedBundleId: bundle.bundleId,
      bundle: forged as unknown as typeof bundle })
    expect(result.ok).toBe(false)
  })

  it('can extract a relation with a previously unseen label from an explicit relation statement', async () => {
    const f = fixture()
    f.append('晶体A与衬底B的关系是外延生长于。', 'm1')
    const item = (await f.sync()).semanticBundle.openAssertions![0]!
    expect(item.relationText).toBe('外延生长于')
    expect(item.participants.map(p => p.text)).toEqual(['晶体A', '衬底B'])
    expect(item.participants.every(p => p.typeCandidate === 'unknown')).toBe(true)
  })

  it('retains a local open event when UIE is unavailable, while keeping rule memories usable', async () => {
    const runs: unknown[] = []
    const extractor = createUieRuleFallbackExtractor({ uie: { extract: async () => { throw new Error('offline') } },
      rules: () => [{ content: '规则记忆', metadata: {} }], onGraphExtraction: (_, run) => { runs.push(run) } })
    expect(await extractor({ userMessage: '我把样品S7放入恒温箱B2。', assistantMessage: '',
      metadata: { sourceMessageIds: ['m1'] } })).toHaveLength(1)
    expect(runs[0]).toMatchObject({ modelId: 'local-open-patterns-v1', status: 'complete', assertionCandidates: [expect.anything()] })
  })

  it('translates only exact capture task segments and does not guess offsets from an arbitrary substring', async () => {
    const f = fixture(), prefix = '前置资料。', segment = '样品S7存放在恒温箱B2。', text = prefix + segment
    f.captures.register({ userMessage: text, assistantMessage: '', metadata: { sourceMessageIds: ['m1'] } }, scope, 'test')
    const run = uieGraphExtractionRun('m1', segment, parseUieOutput(segment, {}))
    run.assertionCandidates![0]!.context.negation = { value: false, resolution: 'resolved', evidenceSpan: { start: 4, end: 7 } }
    f.extractions.append(run)
    expect(projectOpenAssertions(f.captures.snapshot(), f.extractions, scope)).toEqual([])
    const snapshot = f.captures.snapshot()
    snapshot.tasks[0]!.start = prefix.length
    expect(projectOpenAssertions(snapshot, f.extractions, scope)[0]?.evidenceSpan)
      .toEqual({ start: prefix.length, end: text.length })
    expect(projectOpenAssertions(snapshot, f.extractions, scope)[0]?.participants[0]?.span.start).toBe(prefix.length)
    expect(projectOpenAssertions(snapshot, f.extractions, scope)[0]?.context.negation.evidenceSpan)
      .toEqual({ start: prefix.length + 4, end: prefix.length + 7 })
  })

  it('hides a source with ambiguous message identity across sessions and refuses source policy weakening', async () => {
    const f = fixture(), text = '私密样品S7存放在恒温箱B2。'
    f.append(text, 'm1')
    const item = (await f.sync()).semanticBundle.openAssertions![0]!
    f.accept(item.ref.id)
    const view = await f.sync()
    expect(searchOpenAssertions(view.semanticBundle, '私密样品S7', { scope, sensitivities: [] })).toEqual([])
    const snapshot = f.captures.snapshot()
    snapshot.sources.push({ ...snapshot.sources[0]!, id: 'other-source', scope: { ...scope, sessionId: 'another-session' } })
    expect(projectOpenAssertions(snapshot, f.extractions, scope)).toEqual([])
    const forged = structuredClone(f.semantic.snapshot()!)
    ;(forged.openAssertions![0] as unknown as { sharePolicy: string }).sharePolicy = 'allow-remote'
    expect((await f.semantic.publish({ operationId: 'policy-forgery', expectedBundleId: forged.bundleId, bundle: forged })).ok).toBe(false)
  })

  it('preserves pending state when review persistence fails, and removes review data with its extraction source', async () => {
    const f = fixture()
    f.append('样品S7存放在恒温箱B2。', 'm1')
    const item = (await f.sync()).semanticBundle.openAssertions![0]!
    const failing = createGraphExtractionResultStore({ load: f.extractionDisk.load, save: () => { throw new Error('disk-failure') } })
    expect(() => failing.recordOpenReview({ assertionId: item.ref.id, sourceId: 'm1',
      sourceRevision: item.extraction.sourceRevision, status: 'accepted', reason: '核对原文', reviewedAt: 100 })).toThrow('disk-failure')
    expect(failing.openReviews()).toEqual([])
    f.accept(item.ref.id)
    await f.sync()
    f.extractions.removeSources(['m1'])
    expect(f.extractions.openReviews()).toEqual([])
    expect(f.projection.snapshot()).toBeUndefined()
    expect((await f.sync()).semanticBundle.openAssertions).toEqual([])
  })

  it('keeps malformed open extraction in diagnostics without admitting an out-of-evidence participant', () => {
    const sourceText = '晶体A外延生长于衬底B'
    const run = createGraphExtractionRun({ sourceId: 'm1', sourceText, modelId: 'fixture', rawOutput: { graph: {
      entities: [{ id: 'a', type: 'unknown', text: '晶体A', span: { start: 0, end: 3 }, modelScore: 0.9 }], facts: [],
      assertions: [{ id: 'bad', relationText: '外延生长于', participants: [{ mentionId: 'a', role: 'subject' }],
        evidenceSpan: { start: 3, end: 8 }, modelScore: 0.9 }] } } })
    expect(run.status).toBe('incomplete')
    expect(run.assertionCandidates).toEqual([])
    expect((run.rawOutput as { graph: { assertions: unknown[] } }).graph.assertions).toHaveLength(1)
  })
})
