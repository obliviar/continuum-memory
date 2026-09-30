// Node 24+, offline synthetic L2 retrieval comparison. Never loads a user's memory store.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import assert from 'node:assert/strict'
import './register-typescript.mjs'

const { values } = parseArgs({ options: {
  'model-dir': { type: 'string' }, cases: { type: 'string' }, output: { type: 'string' },
} })
if (!values['model-dir'] || !values.cases || !values.output)
  throw Error('Required: --model-dir <installed-cache> --cases <synthetic-json> --output <new-report.json>')
const repo = fileURLToPath(new URL('../../../../../', import.meta.url))
const modelDir = resolve(values['model-dir']), output = resolve(values.output)
if (existsSync(output)) throw Error('Output exists; choose a new report path to preserve earlier results')
mkdirSync(dirname(output), { recursive: true })
const load = path => import(pathToFileURL(join(repo, path)))
const { createL2HostFixture } = await load('packages/memory/src/graph-core/eval/l2-host-regression.ts')
const { createV4L2Memory } = await load('packages/memory/src/graph-core/adapters/v4-l2-memory.ts')
const { createMemoryEmbeddingIndex } = await load('packages/memory/src/long-term/embedding-index.ts')
const { createOnnxEmbedder } = await load('packages/embedding-onnx/src/index.ts')
const { planGraphQuery } = await load('packages/memory/src/graph-core/recall/query-plan.ts')
const { buildGraphEvidencePrompt } = await load('packages/core/src/prompt/graph-evidence-prompt.ts')
const ok = r => { if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`); return r.value }
const hash = text => createHash('sha256').update(text).digest('hex')

const dataset = JSON.parse(readFileSync(resolve(values.cases), 'utf8'))
const { pairs, cases } = dataset
assert.ok(Array.isArray(pairs) && pairs.length > 0 && pairs.length <= 100)
assert.ok(pairs.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(t => typeof t === 'string' && t.trim())))
assert.ok(Array.isArray(cases) && cases.length > 0 && cases.length <= 1000)
assert.equal(new Set(cases.map(c => c.id)).size, cases.length)
for (const c of cases) {
  assert.ok(typeof c.id === 'string' && typeof c.query === 'string' && c.query.trim())
  assert.ok(['literal', 'paraphrase', 'no-answer'].includes(c.category))
  assert.ok(c.pair === null ? c.seed === null && c.category === 'no-answer'
    : Number.isInteger(c.pair) && c.pair >= 0 && c.pair < pairs.length
      && (c.seed === c.pair * 2 || c.seed === c.pair * 2 + 1) && c.category !== 'no-answer')
}

async function fixture() {
  const f = createL2HostFixture(), texts = pairs.flat()
  f.repository.transaction(s => {
    const fact = s.facts[0], version = s.factVersions[0], link = s.evidenceLinks[0]
    s.episodes[0].content = pairs.map(([a, b]) => `${a}导致${b}。`).join('')
    s.facts = texts.map((text, i) => ({ ...fact, id: `event-${i}`, predicate: `event.${i}`, memoryKey: `event.${i}`,
      canonicalText: text, object: text, normalizedValue: text, evidenceLinkIds: [`source-${i}`] }))
    s.factVersions = texts.map((text, i) => ({ ...version, id: `version-${i}`, factId: `event-${i}`, predicate: `event.${i}`,
      canonicalText: text, object: text, normalizedValue: text, evidenceLinkIds: [`source-${i}`] }))
    s.evidenceLinks = texts.map((_, i) => ({ ...link, id: `source-${i}`, factId: `event-${i}` }))
  })
  const prepared = ok(f.port.prepareRelations(f.request().scope)), snapshot = prepared.repository.snapshot()
  const claims = texts.map((_, i) => prepared.core.l1.snapshot().semanticBundle.claims.find(c => c.fact.id === `event-${i}`))
  const relations = pairs.map((_, i) => ({ ref: { kind: 'relation', id: `cause-${i}`, version: 1 },
    from: claims[i * 2].ref, to: claims[i * 2 + 1].ref, kind: 'causes', scope: f.request().scope,
    context: claims[i * 2].context, polarity: 'positive', modality: 'asserted',
    validTime: { kind: 'interval', from: 100, to: null }, assertionBasis: 'source-explicit',
    transactionTime: { recordedAt: 100, closedAt: null }, review: { status: 'accepted', reviewedAt: 100, reviewer: 'synthetic-fixture' },
    provenance: claims[i * 2].provenance, evidence: [{ source: claims[i * 2].provenance.sources[0], role: 'supports' }],
    sensitivity: 'normal', sharePolicy: 'local-only', nliObservationIds: [] }))
  ok(await prepared.repository.publish({ operationId: 'model-benchmark', expectedManifestId: snapshot.manifest.manifestId,
    snapshot: { ...snapshot, manifest: { ...snapshot.manifest, manifestId: 'model-benchmark', relationRevision: 1 }, relations } }))
  return { ...f, claims }
}
const report = { schema: 'l2-real-model-comparison/v1', status: 'running', createdAt: new Date().toISOString(),
  codeVersion: 'working-tree; see source content hashes', repository: repo, codeFiles: Object.fromEntries([
    'packages/memory/src/graph-core/adapters/v4-l2-memory.ts',
    'packages/memory/src/graph-core/recall/l2-seed-ranking.ts',
    'packages/memory/src/graph-core/recall/l2-target-state.ts',
    'packages/memory/src/graph-core/recall/l2-entity-target.ts',
    'packages/memory/src/graph-core/adapters/accepted-l1-input.ts',
    'packages/memory/src/graph-core/recall/query-plan.ts',
    'packages/memory/src/graph-core/recall/direct-semantic.ts',
    'packages/memory/src/graph-core/recall/direct-lexical.ts',
    'packages/memory/src/graph-core/recall/l2-semantic-fallback.ts',
  ].map(path => [path, hash(readFileSync(join(repo, path)))])),
  datasetHash: hash(JSON.stringify(dataset)), dataset, modelDir,
  productionThreshold: 0.8, experimentalFallback: { minCosine: 0.6, minMargin: 0.1, enabledByDefault: false }, budgets: null, measurements: [], diagnostics: [],
  limitations: [
    'Synthetic development set fixed before this run; not human-reviewed, not an external benchmark or held-out validation.',
    'Real local BGE embeddings; no remote API and no private user memories.',
    'In-memory V4/L1/L2 fixture uses reviewed source-explicit relations; extraction, native admission and final answer generation are not evaluated.',
    'Keyword arm includes the existing exact-target/name policy. Hybrid differs only in enabling real dense retrieval.',
    'Default maxSeeds=4, maxHops=2, 500ms embedding timeout and UTF-8 byte budget counter are retained.',
    'Production controls and optional fallback have three alternating-order warm passes; exploratory thresholds have one pass and never change production config.',
  ] }
const save = () => writeFileSync(output, JSON.stringify(report, null, 2))
const embedder = createOnnxEmbedder({ cacheDir: modelDir }), pending = new Set()
const drain = () => Promise.allSettled([...pending])
try {
  const init = performance.now()
  assert.equal(await embedder.verify(), true, 'Local model integrity/probe verification failed')
  report.initializationMs = performance.now() - init; report.model = embedder.model; report.dimensions = embedder.dimensions
  report.integrity = embedder.integrity(); report.modelManifest = JSON.parse(readFileSync(join(modelDir, 'bge-small-zh-v1.5.manifest.json'), 'utf8'))
  const f = await fixture(), cache = createMemoryEmbeddingIndex(), vectors = new Map()
  report.budgets = f.request().budget
  const preparation = performance.now()
  for (const fact of f.repository.snapshot().facts) {
    const vector = await embedder.embed(fact.canonicalText); vectors.set(fact.id, vector)
    cache.putBatch([{ memoryId: fact.id, model: embedder.model, content: fact.canonicalText, vector }])
  }
  report.factPreparationMs = performance.now() - preparation
  const semantic = minCosine => ({ model: embedder.model, dimensions: embedder.dimensions, index: cache, minCosine,
    embedQuery: query => {
      const op = embedder.embed(query).then(vector => ({ model: embedder.model, vector }))
      pending.add(op); void op.then(() => pending.delete(op), () => pending.delete(op)); return op
    } })
  const ports = { lexical: createV4L2Memory(f.options), hybrid: createV4L2Memory({ ...f.options, semantic: semantic(0.8) }),
    fallback: createV4L2Memory({ ...f.options, semantic: semantic(0.8),
      semanticFallback: { model: embedder.model, minCosine: 0.6, minMargin: 0.1 } }),
    plain060: createV4L2Memory({ ...f.options, semantic: semantic(0.6) }),
    exploratory065: createV4L2Memory({ ...f.options, semantic: semantic(0.65) }) }
  const factByClaim = new Map(f.claims.map(c => [c.ref.id, c.fact.id]))
  const priorRelations = f.options.relationPersistence.load()
  async function measure(test, arm, round) {
    await drain()
    const request = { ...f.request(test.query), recallId: `${arm}-${round}-${test.id}` }
    const start = performance.now(), result = await ports[arm].recall(request), elapsedMs = performance.now() - start
    const expectedFacts = test.pair === null ? [] : [`event-${test.pair * 2}`, `event-${test.pair * 2 + 1}`]
    const expectedRelations = test.pair === null ? [] : [`cause-${test.pair}`]
    const expectedSeed = test.seed === null ? null : `event-${test.seed}`
    let row = { id: test.id, category: test.category, query: test.query, arm, round, elapsedMs,
      expectedFacts, expectedRelations, expectedSeed, success: result.ok }
    if (result.ok) {
      buildGraphEvidencePrompt(result.value)
      const actualFacts = result.value.evidence.claims.map(c => c.fact.id), actualRelations = (result.value.evidence.relations ?? []).map(r => r.ref.id)
      const seeds = result.value.trace.candidateRefs.map(ref => factByClaim.get(ref.id))
      const equal = (a, b) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort())
      Object.assign(row, { actualFacts, actualRelations, seeds, exactEvidence: equal(actualFacts, expectedFacts) && equal(actualRelations, expectedRelations),
        seedHit: expectedSeed === null ? seeds.length === 0 : seeds.includes(expectedSeed),
        seedTop1: expectedSeed === null ? seeds.length === 0 : seeds[0] === expectedSeed,
        unexpectedFacts: actualFacts.filter(id => !expectedFacts.includes(id)), missingFacts: expectedFacts.filter(id => !actualFacts.includes(id)),
        searchScope: result.value.trace.searchScope, stopReason: result.value.trace.stopReason, usage: result.value.trace.usage })
    } else Object.assign(row, { error: result.error, exactEvidence: false, seedHit: false, seedTop1: false })
    report.measurements.push(row)
    assert.equal(f.options.relationPersistence.load(), priorRelations, 'Recall must not create or modify relations')
  }
  for (let round = 0; round < 3; round++) {
    console.error(`Production comparison pass ${round + 1}/3 (${cases.length} questions)`)
    for (const [i, test] of cases.entries()) for (const arm of (i + round) % 2 ? ['fallback', 'hybrid', 'lexical'] : ['lexical', 'hybrid', 'fallback'])
      await measure(test, arm, round)
    save()
  }
  for (const arm of ['plain060', 'exploratory065']) {
    console.error(`Exploratory ${arm}; production settings unchanged`)
    for (const test of cases) await measure(test, arm, 0)
    save()
  }
  await drain()
  for (const test of cases) {
    const request = f.request(test.query)
    const planned = ok(planGraphQuery({ query: test.query, relationModel: 'l2', temporal: request.temporal,
      timePlanning: { referenceTime: 200, utcOffsetMinutes: 0 } }))
    const vector = await embedder.embed(planned.searchQuery)
    const scores = f.repository.snapshot().facts.map(fact => ({ id: fact.id, text: fact.canonicalText,
      cosine: vector.reduce((sum, x, i) => sum + x * vectors.get(fact.id)[i], 0) })).sort((a, b) => b.cosine - a.cosine)
    report.diagnostics.push({ id: test.id, query: test.query, targetText: planned.searchQuery,
      expectedSeedScore: test.seed === null ? null : scores.find(s => s.id === `event-${test.seed}`), top3: scores.slice(0, 3) })
  }
  report.status = 'completed'
  // Completion is separate from quality: emit the actual failures, never bless a threshold automatically.
  report.qualityGatePassed = report.measurements.filter(row => row.arm === 'fallback').every(row => row.exactEvidence)
  report.summary = Object.fromEntries(Object.keys(ports).map(arm => {
    const rows = report.measurements.filter(row => row.arm === arm && row.round === 0)
    return [arm, { questions: rows.length, exact: rows.filter(row => row.exactEvidence).length,
      errors: rows.filter(row => !row.success).length,
      failedQueries: rows.filter(row => !row.exactEvidence).map(row => row.query) }]
  }))
  save()
  console.error('Completed real-model comparison; inspect the report for quality failures.')
} catch (error) { report.status = 'failed'; report.error = String(error); save(); process.exitCode = 1 }
finally { await drain(); await embedder.dispose() }
