import { describe, expect, it } from 'vitest'
import { createGraphExtractionRun } from './graph-extraction-result'
import { confirmGraphFactIdentities } from './graph-confirmed-identity'

const scope = { ownerId: 'owner', agentId: 'agent' }
function run(sourceId: string) {
  return createGraphExtractionRun({ sourceId, sourceText: '张三工作于星河公司', modelId: 'uie-base', rawOutput: { graph: {
    entities: [
      { id: 'person', type: 'person', text: '张三', span: { start: 0, end: 2 }, modelScore: 0.9 },
      { id: 'org', type: 'organization', text: '星河公司', span: { start: 5, end: 9 }, modelScore: 0.9 },
    ], facts: [{ id: 'fact', subjectMentionId: 'person', predicate: '工作于', object: { mentionId: 'org' },
      evidenceSpan: { start: 0, end: 9 }, modelScore: 0.9 }],
  } } })
}

describe('confirmed graph identity', () => {
  it('creates isolated stable IDs for unresolved mentions only after explicit confirmation', () => {
    const firstRun = run('message-1')
    const first = confirmGraphFactIdentities(firstRun, firstRun.factCandidates[0]!.id,
      { entities: [], aliases: [], scope })
    expect(first.normalized.facts[0]).toMatchObject({ status: 'ready', predicate: 'worksAt' })
    expect(first.entities).toHaveLength(2)
    expect(first.entities[0]?.ref.id).toMatch(/^confirmed-entity:/)
    const repeated = confirmGraphFactIdentities(firstRun, firstRun.factCandidates[0]!.id,
      { entities: [], aliases: [], scope })
    expect(repeated.entities.map(item => item.ref.id)).toEqual(first.entities.map(item => item.ref.id))
    const rerun = run('message-1')
    expect(confirmGraphFactIdentities(rerun, rerun.factCandidates[0]!.id,
      { entities: [], aliases: [], scope }).entities.map(item => item.ref.id))
      .toEqual(first.entities.map(item => item.ref.id))
    const secondRun = run('message-2')
    const second = confirmGraphFactIdentities(secondRun, secondRun.factCandidates[0]!.id,
      { entities: [], aliases: [], scope })
    expect(second.entities[0]?.ref.id).not.toBe(first.entities[0]?.ref.id)
  })
})
