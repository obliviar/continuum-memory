import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createFeverAbsenceFixture } from '../fixtures/fever-absence'
import { validateGraphRelations } from './validation'
import type { GraphRelationValidationCode, GraphRelationValidationInput } from './validation'

function expectIssue(input: GraphRelationValidationInput, code: GraphRelationValidationCode): void {
  const result = validateGraphRelations(input)
  expect(result.ok).toBe(false)
  expect(result.issues.map(issue => issue.code)).toContain(code)
}

describe('Graph relation consistency (not recall or proof verification)', () => {
  it('accepts the complete causal sample without mutating it', () => {
    const input = createFeverAbsenceFixture()
    const before = JSON.stringify(input)
    expect(validateGraphRelations(input)).toEqual({ ok: true, issues: [] })
    expect(JSON.stringify(input)).toBe(before)
  })

  it('retains both the original and revoked relation versions', () => {
    const input = createFeverAbsenceFixture(true)
    expect(input.bundle.relations.map(item => [item.ref.version, item.status])).toEqual([
      [1, 'active'], [2, 'revoked'],
    ])
    expect(validateGraphRelations(input).ok).toBe(true)
  })

  it('does not reject hypotheses or pending review merely because they cannot justify an answer', () => {
    const input = createFeverAbsenceFixture()
    Object.assign(input.bundle.relations[0]!, {
      assertion: 'hypothesis', support: 'unknown', review: { status: 'candidate' },
    })
    expect(validateGraphRelations(input).ok).toBe(true)
  })

  it('requires an exact endpoint version rather than accepting a matching ID', () => {
    const input = createFeverAbsenceFixture()
    Object.assign(input.bundle.relations[0]!, { from: { kind: 'claim', id: 'C1', version: 2 } })
    expectIssue(input, 'missing-claim')
  })

  it('keeps fixture endpoint references independent of the referenced records', () => {
    const input = createFeverAbsenceFixture()
    Object.assign(input.bundle.relations[0]!.from, { version: 2 })
    expect(input.bundle.claims[0]!.ref.version).toBe(1)
    expect(createFeverAbsenceFixture().bundle.relations[0]!.from.version).toBe(1)
    expectIssue(input, 'missing-claim')
  })

  it('requires an exact relation version on the projection edge', () => {
    const input = createFeverAbsenceFixture()
    Object.assign(input.edges[0]!, { relationRef: { kind: 'relation', id: 'R1', version: 2 } })
    expectIssue(input, 'missing-relation')
  })

  it('detects the rule-reference typo even before a graph reader exists', () => {
    const input = createFeverAbsenceFixture()
    Object.assign(input.bundle.relations[0]!, { ref: { kind: 'rule', id: 'R1', version: 1 } })
    expectIssue(input, 'invalid-reference')
  })

  it('rejects duplicate record versions but allows historical versions with the same ID', () => {
    const input = createFeverAbsenceFixture()
    Object.assign(input.bundle, { relations: [input.bundle.relations[0], input.bundle.relations[0]] })
    expectIssue(input, 'duplicate-reference')
  })

  it.each(['ownerId', 'agentId', 'sessionId'] as const)('rejects a relation spanning an incompatible %s', (field) => {
    const input = createFeverAbsenceFixture()
    const claim = input.bundle.claims[0]!
    Object.assign(claim, { scope: { ...claim.scope, [field]: 'other' } })
    expectIssue(input, 'scope-mismatch')
  })

  it('accepts a single-session relation referencing owner-wide facts', () => {
    const input = createFeverAbsenceFixture()
    const relation = input.bundle.relations[0]!
    Object.assign(relation, { scope: { ...relation.scope, sessionId: 'session-1' } })
    expect(validateGraphRelations(input).ok).toBe(true)
  })

  it('rejects a relation connecting different context versions', () => {
    const input = createFeverAbsenceFixture()
    const other = structuredClone(input.bundle.contexts[0]!)
    Object.assign(other, { ref: { kind: 'context', id: 'hypothetical-work', version: 1 }, scenario: 'hypothetical' })
    Object.assign(input.bundle, { contexts: [...input.bundle.contexts, other] })
    Object.assign(input.bundle.claims[0]!, { context: other.ref })
    expectIssue(input, 'context-mismatch')
  })

  it('requires an existing context and entity', () => {
    const input = createFeverAbsenceFixture()
    Object.assign(input.bundle, { contexts: [], entities: [] })
    expectIssue(input, 'missing-context')
    expectIssue(input, 'missing-entity')
  })

  it('requires the exact referenced V4 fact version', () => {
    const input = createFeverAbsenceFixture()
    Object.assign(input.factVersions[0]!, { ref: { kind: 'v4-fact', id: 'F1', version: 2 } })
    expectIssue(input, 'missing-fact-version')
  })

  it.each([
    { kind: 'interval', from: 20, to: 10 },
    { kind: 'interval', from: 10, to: 10 },
    { kind: 'interval', from: Number.NaN, to: 20 },
    { kind: 'interval', from: null, to: Number.POSITIVE_INFINITY },
  ])('rejects malformed validity intervals: %j', (validTime) => {
    const input = createFeverAbsenceFixture()
    Object.assign(input.bundle.relations[0]!, { validTime })
    expectIssue(input, 'invalid-time')
  })

  it('rejects transaction closure before the record was created', () => {
    const input = createFeverAbsenceFixture()
    Object.assign(input.bundle.relations[0]!, { transactionTime: { recordedAt: 20, closedAt: 10 } })
    expectIssue(input, 'invalid-time')
  })

  it.each([{ kind: 'unknown' }, { kind: 'interval', from: null, to: null }])('preserves unknown or unbounded time: %j', (validTime) => {
    const input = createFeverAbsenceFixture()
    Object.assign(input.bundle.relations[0]!, { validTime })
    expect(validateGraphRelations(input).ok).toBe(true)
  })

  it('allows BEFORE to connect non-overlapping event times', () => {
    const input = createFeverAbsenceFixture()
    Object.assign(input.bundle.relations[0]!, { kind: 'before', from: input.bundle.claims[2]!.ref })
    Object.assign(input.edges[0]!, { kind: 'before', from: input.bundle.claims[2]!.ref })
    // Structural consistency does not assert that the text actually supports BEFORE.
    expect(validateGraphRelations(input).ok).toBe(true)
  })

  it('rejects missing or changed source content', () => {
    const missing = createFeverAbsenceFixture()
    Object.assign(missing, { sources: [] })
    expectIssue(missing, 'missing-source')
    const changed = createFeverAbsenceFixture()
    Object.assign(changed.sources[0]!, { content: 'tampered text' })
    expectIssue(changed, 'source-hash-mismatch')
  })

  it('cannot silently redirect a reference to the newest source hash', () => {
    const input = createFeverAbsenceFixture()
    const content = 'A newer version of the original episode.'
    Object.assign(input.sources[0]!, { content, contentHash: createHash('sha256').update(content).digest('hex') })
    expectIssue(input, 'missing-source')
  })

  it('rejects evidence belonging to a different owner', () => {
    const input = createFeverAbsenceFixture()
    Object.assign(input.sources[0]!, { scope: { ownerId: 'other', agentId: 'fixture-agent' } })
    expectIssue(input, 'scope-mismatch')
  })

  it.each([
    { kind: 'text-span', unit: 'utf16', start: -1, end: 2 },
    { kind: 'text-span', unit: 'utf16', start: 2, end: 2 },
    { kind: 'text-span', unit: 'utf16', start: 0, end: 9999 },
    { kind: 'text-span', unit: 'utf16', start: 0.5, end: 2 },
  ])('rejects invalid source ranges: %j', (locator) => {
    const input = createFeverAbsenceFixture()
    const source = { ...input.bundle.relations[0]!.evidence[0].source, locator }
    Object.assign(input.bundle.relations[0]!, { evidence: [{ source, role: 'supports' }] })
    expectIssue(input, 'invalid-source-span')
  })

  it('rejects a span splitting a UTF-16 surrogate pair', () => {
    const input = createFeverAbsenceFixture()
    const content = 'A😀B'
    const source = { episodeId: 'emoji', contentHash: createHash('sha256').update(content).digest('hex') }
    Object.assign(input, { sources: [...input.sources, { ...source, content, scope: input.bundle.scope }] })
    Object.assign(input.bundle.relations[0]!, { evidence: [{
      role: 'supports', source: { ...source, locator: { kind: 'text-span', unit: 'utf16', start: 1, end: 2 } },
    }] })
    expectIssue(input, 'invalid-source-span')
  })

  it('does not accept reference-only evidence as a declared supported relation', () => {
    const input = createFeverAbsenceFixture()
    Object.assign(input.bundle.relations[0]!, { evidence: [{
      source: input.bundle.relations[0]!.evidence[0].source, role: 'references',
    }] })
    expectIssue(input, 'missing-evidence')
  })

  it('requires evidence even if an empty array came from deserialization', () => {
    const input = createFeverAbsenceFixture()
    Object.assign(input.bundle.relations[0]!, { evidence: [] })
    expectIssue(input, 'missing-evidence')
  })

  it('requires supporting and refuting references for a conflicted declaration', () => {
    const input = createFeverAbsenceFixture()
    Object.assign(input.bundle.relations[0]!, { support: 'conflicted' })
    expectIssue(input, 'missing-evidence')
  })

  it.each(['kind', 'direction', 'version'])('detects an edge/record mismatch in %s', (field) => {
    const input = createFeverAbsenceFixture()
    const relation = input.bundle.relations[0]!
    Object.assign(input.edges[0]!, field === 'kind' ? { kind: 'before' }
      : field === 'direction' ? { from: relation.to, to: relation.from }
        : { from: { ...relation.from, version: 2 } })
    expectIssue(input, 'edge-mismatch')
  })

  it('rejects an invalid relation-set revision', () => {
    const input = createFeverAbsenceFixture()
    Object.assign(input.bundle.revisions, { relations: -1 })
    expectIssue(input, 'invalid-revision')
  })

  it('does not expose source text in error messages', () => {
    const input = createFeverAbsenceFixture()
    Object.assign(input.sources[0]!, { content: 'PRIVATE TEST SENTENCE' })
    const result = validateGraphRelations(input)
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('PRIVATE TEST SENTENCE')
  })
})
