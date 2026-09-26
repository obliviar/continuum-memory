import { describe, expect, it } from 'vitest'
import { createGraphExtractionRun } from './graph-extraction-result'
import { createGraphNormalizationStore } from './graph-normalization-store'
import {
  createGraphPredicateRegistry,
  normalizeGraphExtraction,
  type GraphEntityRecord,
} from './graph-identity-normalization'

const scope = { ownerId: 'owner', agentId: 'agent' }
const entity = (id: string, entityType: string, canonicalName: string, aliases: string[] = []): GraphEntityRecord => ({
  ref: { kind: 'entity', id, version: 1 }, scope, entityType, canonicalName, aliases,
})
const alex = entity('person-alex', 'person', 'Alexander', ['Alex'])
const acme = entity('org-acme', 'organization', 'Acme Incorporated', ['Acme'])

function run(sourceText: string, mentions: Array<{ id: string; text: string; type: string }>, facts: unknown[]) {
  return createGraphExtractionRun({
    sourceId: 'message-1', sourceText, modelId: 'uie-test',
    rawOutput: { graph: {
      entities: mentions.map(mention => ({ ...mention,
        span: { start: sourceText.indexOf(mention.text), end: sourceText.indexOf(mention.text) + mention.text.length },
        modelScore: 0.91,
      })), facts,
    } },
  })
}

const absentContext = {
  negation: { value: null, resolution: 'absent' },
  condition: { value: null, resolution: 'absent' },
  time: { value: null, resolution: 'absent' },
  speaker: { value: null, resolution: 'absent' },
}

describe('graph identity and predicate normalization', () => {
  it('resolves established aliases and assigns arguments to directed roles', () => {
    const sourceText = 'Acme employs Alex'
    const extraction = run(sourceText, [
      { id: 'org', text: 'Acme', type: 'organization' },
      { id: 'person', text: 'Alex', type: 'person' },
    ], [{ id: 'f1', subjectMentionId: 'org', predicate: 'employs', object: { mentionId: 'person' },
      evidenceSpan: { start: 0, end: sourceText.length }, modelScore: 0.93, context: absentContext }])
    const result = normalizeGraphExtraction(extraction, { entities: [alex, acme], scope })
    expect(result.resolutions).toMatchObject([
      { mentionId: 'org', status: 'resolved', entityId: 'org-acme', basis: 'alias' },
      { mentionId: 'person', status: 'resolved', entityId: 'person-alex', basis: 'alias' },
    ])
    expect(result.facts[0]).toMatchObject({ status: 'ready', predicate: 'worksAt', arguments: {
      person: { kind: 'entity', entityId: 'person-alex' },
      organization: { kind: 'entity', entityId: 'org-acme' },
    } })
  })

  it('leaves names and vector neighbours unresolved without identity evidence', () => {
    const sourceText = 'Alex works at Acme'
    const extraction = run(sourceText, [
      { id: 'person', text: 'Alex', type: 'person' },
      { id: 'org', text: 'Acme', type: 'organization' },
    ], [{ id: 'f1', subjectMentionId: 'person', predicate: 'works at', object: { mentionId: 'org' },
      evidenceSpan: { start: 0, end: sourceText.length }, modelScore: 0.95, context: absentContext }])
    const sameName = entity('other-alex', 'person', 'Alex')
    const result = normalizeGraphExtraction(extraction, {
      entities: [sameName, acme], scope,
      vectorCandidatesByMentionId: { person: [{ entityId: 'other-alex', score: 0.99 }] },
    })
    expect(result.resolutions[0]).toMatchObject({ status: 'unresolved', candidates: expect.arrayContaining([
      { entityId: 'other-alex', basis: 'canonical-name' },
      { entityId: 'other-alex', basis: 'vector', score: 0.99 },
    ]) })
    expect(result.facts[0]).toMatchObject({ status: 'unresolved', reason: 'unresolved-subject' })
    const contextual = normalizeGraphExtraction(extraction, {
      entities: [sameName, acme], scope, contextEntityIds: ['other-alex'],
    })
    expect(contextual.resolutions[0]).toMatchObject({ status: 'resolved', entityId: 'other-alex', basis: 'context' })
    const explicit = normalizeGraphExtraction(extraction, {
      entities: [sameName, acme], scope, explicitIdentityByMentionId: { person: 'other-alex' },
    })
    expect(explicit.resolutions[0]).toMatchObject({ status: 'resolved', entityId: 'other-alex', basis: 'explicit-id' })
    const wrongScope = normalizeGraphExtraction(extraction, {
      entities: [{ ...sameName, scope: { ownerId: 'someone-else', agentId: 'agent' } }, acme],
      scope, explicitIdentityByMentionId: { person: 'other-alex' },
    })
    expect(wrongScope.resolutions[0]).toMatchObject({ status: 'unresolved', reason: 'invalid-explicit-id' })
    const unreviewed = normalizeGraphExtraction(extraction, {
      entities: [{ ...sameName, review: { status: 'candidate' } }, acme], scope,
      explicitIdentityByMentionId: { person: 'other-alex' },
    })
    expect(unreviewed.resolutions[0]).toMatchObject({ status: 'unresolved', reason: 'invalid-explicit-id' })
  })

  it('preserves dates and amounts as typed values and rejects unknown predicates', () => {
    const sourceText = 'Alex 2020-01-02 ¥1,200'
    const extraction = run(sourceText, [{ id: 'person', text: 'Alex', type: 'person' }], [
      { id: 'date', subjectMentionId: 'person', predicate: 'born on',
        object: { literal: '2020-01-02', valueType: 'date' },
        evidenceSpan: { start: 0, end: 15 }, modelScore: 0.9, context: absentContext },
      { id: 'amount', subjectMentionId: 'person', predicate: 'salary is',
        object: { literal: '¥1,200', valueType: 'amount' },
        evidenceSpan: { start: 0, end: sourceText.length }, modelScore: 0.9, context: absentContext },
      { id: 'unknown', subjectMentionId: 'person', predicate: 'possibly-knows',
        object: { literal: 'Someone' }, evidenceSpan: { start: 0, end: sourceText.length },
        modelScore: 0.9, context: absentContext },
    ])
    const result = normalizeGraphExtraction(extraction, { entities: [alex], scope })
    expect(result.facts[0]).toMatchObject({ status: 'ready', arguments: { date: { kind: 'date', value: '2020-01-02' } } })
    expect(result.facts[1]).toMatchObject({ status: 'ready', arguments: { amount: { kind: 'number', value: 1200, unit: 'CNY' } } })
    expect(result.facts[2]).toMatchObject({ status: 'unresolved', reason: 'unknown-predicate' })
  })

  it('maps headquarters to organization and location roles', () => {
    const sourceText = 'Acme 总部位于 上海'
    const location = entity('loc-shanghai', 'location', 'Shanghai City', ['上海'])
    const extraction = run(sourceText, [
      { id: 'org', text: 'Acme', type: 'organization' },
      { id: 'loc', text: '上海', type: 'location' },
    ], [{ id: 'hq', subjectMentionId: 'org', predicate: '总部位于', object: { mentionId: 'loc' },
      evidenceSpan: { start: 0, end: sourceText.length }, modelScore: 0.9, context: absentContext }])
    const result = normalizeGraphExtraction(extraction, { entities: [acme, location], scope })
    expect(result.facts[0]).toMatchObject({ status: 'ready', predicate: 'headquartersIn', arguments: {
      organization: { kind: 'entity', entityId: 'org-acme' },
      location: { kind: 'entity', entityId: 'loc-shanghai' },
    } })
  })

  it('keeps normalized decisions in a separate persisted store', () => {
    let payload: string | undefined
    const persistence = { load: () => payload, save: (value: string) => { payload = value } }
    const store = createGraphNormalizationStore(persistence)
    store.replaceCatalog([alex], [])
    const extraction = run('Alex', [{ id: 'person', text: 'Alex', type: 'person' }], [])
    const result = normalizeGraphExtraction(extraction, { entities: store.entities(), scope })
    store.appendResult(result)
    expect(createGraphNormalizationStore(persistence).results()[0]?.resolutions[0]?.entityId).toBe('person-alex')
    expect(payload).not.toContain('rawOutput')
    store.removeSources(['message-1'])
    expect(store.results()).toEqual([])
    expect(store.entities()).toHaveLength(1)
  })

  it('applies an accepted merge and lets a later split revoke it', () => {
    const secondary = entity('person-secondary', 'person', 'Secondary', ['Alex'])
    const extraction = run('Alex', [{ id: 'person', text: 'Alex', type: 'person' }], [])
    const merge = {
      ref: { kind: 'alias-decision' as const, id: 'decision-1', version: 1 },
      action: 'merge' as const,
      members: [secondary.ref], canonical: alex.ref,
      review: { status: 'accepted' }, transactionTime: { recordedAt: 1 },
    }
    const merged = normalizeGraphExtraction(extraction, { entities: [alex, secondary], aliasDecisions: [merge], scope })
    expect(merged.resolutions[0]).toMatchObject({ status: 'resolved', entityId: 'person-alex' })
    const split = { ...merge, ref: { ...merge.ref, id: 'decision-2' }, action: 'split' as const,
      transactionTime: { recordedAt: 2 } }
    const separated = normalizeGraphExtraction(extraction, { entities: [alex, secondary], aliasDecisions: [merge, split], scope })
    expect(separated.resolutions[0]).toMatchObject({ status: 'unresolved' })
  })

  it('rejects duplicate natural-language predicate labels', () => {
    expect(() => createGraphPredicateRegistry([
      { spec: { ref: { kind: 'predicate', id: 'x', version: 1 }, name: 'x',
        roles: { a: { type: 'string', required: true }, b: { type: 'string', required: true } },
        cardinality: 'multiple', keyRoles: ['a'], valueRole: 'b', symmetry: 'none',
        transitivity: 'none', inferenceAllowed: false, world: 'open' },
      sourceRole: 'a', targetRole: 'b', labels: [
        { text: 'same', direction: 'forward' }, { text: ' SAME ', direction: 'reverse' },
      ] },
    ])).toThrow(/Duplicate/)
  })
})
