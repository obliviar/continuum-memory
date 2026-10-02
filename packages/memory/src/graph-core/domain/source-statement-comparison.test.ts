import { describe, expect, it } from 'vitest'
import type { GraphClaimRecord, GraphEntityRecord } from './types'
import { basicStatementIdentitiesCompatible, renderSourceStatementComparison } from './source-statement-comparison'

const entities = [
  { ref: { kind: 'entity', id: 'a', version: 1 }, canonicalName: '张三' },
  { ref: { kind: 'entity', id: 'b', version: 1 }, canonicalName: '张三' },
] as GraphEntityRecord[]
const claim = (id: string) => ({ atom: { predicate: 'basic', args: { subject: { kind: 'entity', ref: { kind: 'entity', id, version: 1 } } } },
  ref: { kind: 'claim', id, version: 1 }, fact: { kind: 'v4-fact', id: `fact:${id}`, version: 1 },
  scope: { ownerId: 'owner', agentId: 'agent' }, transactionTime: { recordedAt: 1, closedAt: null },
  provenance: { sources: [{ episodeId: 'source', contentHash: 'hash', locator: { kind: 'text-span', unit: 'utf16', start: 0, end: 2 } }],
    producer: 'extractor', normalizerVersion: 'test' }, review: { status: 'accepted', reviewedAt: 1, reviewer: 'test' },
  sensitivity: 'normal', sharePolicy: 'allow-remote', context: { kind: 'context', id: 'context', version: 1 },
  evidence: [{ source: { episodeId: 'source', contentHash: 'hash', locator: { kind: 'text-span', unit: 'utf16', start: 0, end: 2 } },
    role: 'supports', strength: 'direct' }],
  sourceStatement: { predicateId: 'basic', predicateVersion: 1, relationText: '接手', relationSpan: { start: 2, end: 4 } },
  polarity: 'positive', modality: 'planned', condition: { kind: 'none' }, validTime: { kind: 'unknown' },
}) as GraphClaimRecord

describe('source-defined L1 to L2 comparison', () => {
  it('does not treat matching names as matching source-local identities', () => {
    expect(basicStatementIdentitiesCompatible(claim('a'), claim('b'), entities)).toBe(false)
    expect(basicStatementIdentitiesCompatible(claim('a'), claim('a'), entities)).toBe(true)
  })
  it('keeps the role, planned modality and original evidence visible to NLI', () => {
    const rendered = renderSourceStatementComparison(claim('a'), entities, '张三计划下周接手项目A。')
    expect(rendered).toContain('subject：张三')
    expect(rendered).toContain('planned')
    expect(rendered).toContain('张三计划下周接手项目A。')
  })
  it('preserves the original comparison text for existing normalized Claims', () => {
    const normalized = { ...claim('a'), sourceStatement: undefined }
    expect(renderSourceStatementComparison(normalized, entities, 'original')).toBe('original')
  })
})
