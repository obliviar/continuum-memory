import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { createConversationRegistry } from './conversation-registry'

const storage = () => { let payload: string | undefined; return { load: () => payload, save: (next: string) => { payload = next } } }
describe('desktop conversations and memory partitions', () => {
  it('keeps legacy history and memories in their existing location and gives new conversations independent spaces', () => {
    const persistence = storage(), registry = createConversationRegistry({ persistence, legacySessionIds: ['default', 'legacy-2'] })
    expect(registry.active().id).toBe('default')
    expect(registry.directory('default', 'root')).toBe('root')
    const a = registry.create('对话 A'), b = registry.create('对话 B')
    expect(a.id).not.toBe(a.memorySpaceId)
    expect(a.memorySpaceId).not.toBe(b.memorySpaceId)
    expect(registry.directory(a.id, 'root')).toBe(join('root', 'memory-spaces', a.memorySpaceId))
    expect(registry.directory(a.id, 'root')).not.toBe(registry.directory(b.id, 'root'))
    registry.select(a.id); registry.rename(a.id, '项目 A')
    const restarted = createConversationRegistry({ persistence })
    expect(restarted.active()).toMatchObject({ id: a.id, title: '项目 A', memorySpaceId: a.memorySpaceId })
    expect(restarted.list()).toHaveLength(4)
    expect(() => restarted.select('unknown')).toThrow()
  })
  it('rejects corrupted or unsafe partition mappings rather than widening to the legacy store', () => {
    for (const value of [
      { version: 1, activeId: 'a', conversations: [{ id: 'a', title: 'A', createdAt: 1, memorySpaceId: '../other' }] },
      { version: 1, activeId: 'a', conversations: [{ id: 'a', title: 'A', createdAt: 1, memorySpaceId: 'legacy-default', legacyRoot: true }] },
      { version: 1, activeId: 'missing', conversations: [] },
    ]) expect(() => createConversationRegistry({ persistence: { load: () => JSON.stringify(value), save() {} } })).toThrow()
  })
  it('does not change selection when registry persistence fails', () => {
    const saved = storage()
    const registry = createConversationRegistry({ persistence: saved })
    const registryWithFailure = createConversationRegistry({ persistence: { load: saved.load, save() { throw new Error('disk full') } } })
    expect(() => registryWithFailure.create('A')).toThrow('disk full')
    expect(registryWithFailure.active().id).toBe(registry.active().id)
  })
})
