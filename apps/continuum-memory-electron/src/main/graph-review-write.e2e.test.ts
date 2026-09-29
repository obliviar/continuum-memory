import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reactive } from 'vue'
import { describe, expect, it } from 'vitest'
import {
  assessGraphClaim, confirmGraphClaim, confirmGraphFactIdentities, createCaptureRepository,
  createEncryptedFilePersistence, createEncryptedGraphL1Persistence, createEncryptedV4Persistence,
  createGraphExtractionResultStore, createGraphL1ProjectionRepository, createGraphL1Store,
  createGraphL1Writer, createGraphNormalizationStore, createGraphPredicateRegistry,
  createGraphSemanticRepository, createLocalUieExtractor, createMemoryV4Repository,
  createMemoryWriter, createUieRuleFallbackExtractor, createVectorStore, inferMemoryPrivacy,
  localUieScriptPath, normalizeGraphExtraction, reviewGraphAdmission, setGraphUseAssessment,
  type GraphAdmissionChoices,
} from '@continuum-memory/memory'
import { graphReviewIpcFields } from '../shared/graph-review-ipc'

const scope = { ownerId: 'graph-e2e-owner', agentId: 'graph-e2e-agent' }

describe('actual UIE desktop graph write', () => {
  it.skipIf(!process.env.CONTINUUM_MEMORY_UIE_PYTHON || !process.env.CONTINUUM_MEMORY_UIE_MODEL_PATH)(
    'captures, extracts, reviews, publishes and reloads a Claim from encrypted graph stores', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'continuum-graph-write-'))
      // This isolated test uses an identity key protector; the desktop host uses OS safeStorage.
      const keyOptions = (name: string) => ({ encryptedPath: join(directory, `${name}.enc`),
        keyPath: join(directory, `${name}.key`), protectKey: (key: Buffer) => key,
        unprotectKey: (key: Buffer) => key })
      const encrypted = (name: string) => createEncryptedFilePersistence(keyOptions(name))
      const model = createLocalUieExtractor({ pythonPath: process.env.CONTINUUM_MEMORY_UIE_PYTHON!,
        modelPath: process.env.CONTINUUM_MEMORY_UIE_MODEL_PATH!, modelHome: '', scriptPath: localUieScriptPath,
        timeoutMs: 120_000 })
      try {
        const captures = createCaptureRepository({ persistence: encrypted('captures') })
        const extractions = createGraphExtractionResultStore(encrypted('extractions'))
        const normalization = createGraphNormalizationStore(encrypted('normalization'))
        const v4 = createMemoryV4Repository({ persistence: createEncryptedV4Persistence(keyOptions('memory-v4')) })
        const l1 = createGraphL1Store(createEncryptedGraphL1Persistence(keyOptions('graph-l1')))
        const registry = createGraphPredicateRegistry()
        const semantic = createGraphSemanticRepository(encrypted('graph-semantic'), v4, captures)
        const projection = createGraphL1ProjectionRepository(encrypted('graph-projection'), semantic, v4, l1, captures)
        const graphWriter = createGraphL1Writer(v4, l1, registry, scope, { syncFromClaims: async () => {
          const result = await semantic.syncFromClaims(l1, v4, registry, scope)
          if (!result.ok || !projection.sync()) throw new Error('Stable graph publication failed')
        } })
        const extractor = createUieRuleFallbackExtractor({ uie: model, rules: () => [],
          onGraphExtraction: (_, run) => {
            extractions.append(run)
            const normalized = normalizeGraphExtraction(run, { entities: normalization.entities(), scope })
            normalization.appendResult(normalized)
            for (const fact of normalized.facts)
              l1.recordReview(assessGraphClaim(run, fact, inferMemoryPrivacy(run.sourceText)))
          } })
        const memory = createMemoryWriter({ store: createVectorStore({ persistence: encrypted('memories') }),
          captureRepository: captures, extractor, onCaptureSourcesChanged: () => {
            void semantic.syncFromClaims(l1, v4, registry, scope).then(() => projection.sync())
          } })

        const text = '我喜欢图论课'
        await memory.capture({ userMessage: text, assistantMessage: '',
          metadata: { sourceMessageIds: ['graph-e2e-message'] } }, scope)
        const run = extractions.list()[0]!
        expect(run.factCandidates).toHaveLength(1)
        expect(l1.reviews()[0]?.status).toBe('pending')
        const candidate = run.factCandidates[0]!
        const identities = { [candidate.subjectMentionId]: 'new',
          ...('mentionId' in candidate.object ? { [candidate.object.mentionId]: 'new' } : {}) }
        const form = reactive({ context: { negation: 'positive', condition: 'none', conditionText: '',
          time: 'none', speaker: 'self', speakerName: '' }, identities })
        const submitted = structuredClone({ id: l1.reviews()[0]!.id, outcome: 'approved',
          reason: 'Verified exact source, identity and context', sourceRevision: run.sourceRevision,
          retrievalRetain: true, proactivePreference: true,
          ...graphReviewIpcFields(form.context, form.identities) })
        const admission = reviewGraphAdmission(run, candidate.id,
          submitted.context as GraphAdmissionChoices, submitted.identities!)
        const confirmed = confirmGraphFactIdentities(run, candidate.id, { entities: normalization.entities(),
          aliases: normalization.aliasDecisions(), scope, choicesByMentionId: admission.identities })
        const fact = confirmed.normalized.facts.find(item => item.sourceFactId === candidate.id)!
        expect(fact.status).toBe('ready')
        normalization.replaceCatalog(confirmed.entities, normalization.aliasDecisions())
        normalization.appendResult(confirmed.normalized)
        const approved = setGraphUseAssessment(confirmGraphClaim(l1.reviews()[0]!, submitted.reason),
          { retrievalRetain: true, proactivePreference: true, reason: submitted.reason })
        expect((await graphWriter.submit(run, fact, approved, confirmed.entities, admission))?.state).toBe('published')
        expect(v4.snapshot().facts).toHaveLength(1)
        expect(v4.snapshot().evidenceLinks).toHaveLength(1)
        expect(l1.claims()).toHaveLength(1)
        expect(projection.snapshot()?.semanticBundle.claims).toHaveLength(1)
        expect(projection.snapshot()?.semanticBundle.information).toHaveLength(1)
        expect(projection.snapshot()?.edges.filter(edge => edge.kind === 'has-argument')).toHaveLength(2)

        const reloadedCaptures = createCaptureRepository({ persistence: encrypted('captures') })
        const reloadedV4 = createMemoryV4Repository({ persistence: createEncryptedV4Persistence(keyOptions('memory-v4')) })
        const reloadedL1 = createGraphL1Store(createEncryptedGraphL1Persistence(keyOptions('graph-l1')))
        const reloadedSemantic = createGraphSemanticRepository(encrypted('graph-semantic'), reloadedV4, reloadedCaptures)
        const reloadedProjection = createGraphL1ProjectionRepository(encrypted('graph-projection'),
          reloadedSemantic, reloadedV4, reloadedL1, reloadedCaptures)
        expect(reloadedL1.tasks()[0]?.state).toBe('published')
        expect(reloadedProjection.snapshot()?.semanticBundle.claims[0]?.atom.predicate).toBe('likes')
        expect(reloadedProjection.snapshot()?.semanticBundle.information?.[0]?.content).toBe(text)
        expect(readFileSync(join(directory, 'graph-projection.enc'), 'utf8')).not.toContain(text)
      }
      finally { model.dispose(); rmSync(directory, { recursive: true, force: true }) }
    }, 180_000)
})
