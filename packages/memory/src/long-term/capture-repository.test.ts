import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryCapture } from '@continuum-memory/contracts'
import { createCaptureRepository } from './capture-repository'
import { createEncryptedFilePersistence } from './encrypted-persistence'
import { createMemoryWriter } from './memory-writer'
import { createVectorStore } from './vector-store'

const scope = { ownerId: 'owner', agentId: 'agent', sessionId: 'session' }
const turn = (userMessage = '原文\n  保留空白😀', id = 'message'): MemoryCapture => ({
  userMessage, assistantMessage: '', metadata: { sourceMessageIds: [id] },
})
function persistence() {
  let payload: string | undefined
  return { load: () => payload, save: (value: string) => { payload = value } }
}
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('independent source and task inbox', () => {
  it('persists original text and all offset-bearing tasks before extraction, including zero candidates', async () => {
    const disk = persistence()
    const repository = createCaptureRepository({ persistence: disk })
    const text = `${'字'.repeat(255)}😀\n　 Ａ  原文${'后'.repeat(300)}`
    const seen: string[] = []
    const writer = createMemoryWriter({
      store: createVectorStore(), captureRepository: repository, maximumSegmentCharacters: 256,
      extractor: input => {
        const saved = JSON.parse(disk.load()!)
        expect(saved.sources[0].turn.userMessage).toBe(text)
        expect(saved.tasks).toHaveLength(3)
        seen.push(input.userMessage)
        return []
      },
    })
    expect(await writer.capture(turn(text), scope)).toBe(0)
    await writer.flushPendingCaptures()
    expect(seen.join('')).toBe(text)
    const snapshot = repository.snapshot()
    expect(snapshot.tasks.every(task => task.status === 'succeeded' && task.candidateCount === 0 && task.writtenCount === 0)).toBe(true)
    expect(snapshot.tasks[0]?.end).toBe(255)
    for (const task of snapshot.tasks) expect(text.slice(task.start, task.end)).toBe(seen[task.segmentIndex])
    expect(await writer.count(scope)).toBe(0)
  })

  it('deduplicates repeated message delivery but isolates owners, sessions and anonymous submissions', () => {
    const repository = createCaptureRepository({ persistence: persistence() })
    const first = repository.register(turn(), scope, 'rules-v1')
    expect(repository.register(turn(), scope, 'rules-v1')).toEqual(first)
    repository.register(turn(), { ...scope, ownerId: 'other' }, 'rules-v1')
    repository.register(turn(), { ...scope, sessionId: 'other' }, 'rules-v1')
    repository.register({ userMessage: 'same', assistantMessage: '' }, scope, 'rules-v1')
    repository.register({ userMessage: 'same', assistantMessage: '' }, scope, 'rules-v1')
    expect(repository.snapshot().sources).toHaveLength(5)
  })

  it('keeps session-qualified source identity separate from the caller write scope', () => {
    const repository = createCaptureRepository({ persistence: persistence() })
    const ownerScope = { ownerId: 'owner', agentId: 'agent' }
    const task = repository.register({ ...turn(), metadata: { sourceMessageIds: ['message'], sessionId: 'session' } }, ownerScope, 'v1')[0]!
    expect(repository.snapshot().sources[0]).toMatchObject({
      scope: { ...ownerScope, sessionId: 'session' }, writeScope: ownerScope,
    })
    expect(repository.claim(task.id)?.scope).toEqual(ownerScope)
  })

  it('versions edits and cancels stale work without changing old raw evidence', () => {
    const repository = createCaptureRepository({ persistence: persistence() })
    const first = repository.register(turn('旧文本'), scope, 'v1')[0]!
    repository.claim(first.id)
    repository.register(turn('新文本'), scope, 'v1')
    expect(repository.isCurrent(first.id)).toBe(false)
    expect(repository.snapshot().sources.map(source => [source.revision, source.status, source.turn?.userMessage]))
      .toEqual([[1, 'superseded', '旧文本'], [2, 'active', '新文本']])
    expect(repository.snapshot().tasks[0]?.status).toBe('cancelled')
  })

  it('recovers interrupted and pending segments after restart and respects processor versions', async () => {
    const disk = persistence()
    const first = createCaptureRepository({ persistence: disk })
    const tasks = first.register(turn('长'.repeat(600)), scope, 'rules-v1', 256)
    first.claim(tasks[0]!.id)
    const recovered = createCaptureRepository({ persistence: disk })
    const extract = vi.fn(() => [])
    const writer = createMemoryWriter({ store: createVectorStore(), captureRepository: recovered,
      captureProcessorVersion: 'rules-v1', extractor: extract })
    expect(recovered.pending('uie-v1')).toHaveLength(0)
    const recovery = writer.resumePendingCaptures()
    await writer.flushPendingCaptures()
    expect(extract).toHaveBeenCalledTimes(3)
    await recovery
    expect(recovered.snapshot().tasks.map(task => task.attempts)).toEqual([2, 1, 1])
    await writer.resumePendingCaptures()
    expect(extract).toHaveBeenCalledTimes(3)
  })

  it('records failures separately from empty success and permits bounded explicit retries', async () => {
    const disk = persistence()
    const repository = createCaptureRepository({ persistence: disk, maximumAttempts: 2 })
    const extract = vi.fn(() => { throw new Error('sensitive raw error must not be persisted') })
    const writer = createMemoryWriter({ store: createVectorStore(), captureRepository: repository, extractor: extract })
    await writer.capture(turn(), scope)
    expect(repository.snapshot().tasks[0]).toMatchObject({ status: 'failed', attempts: 1, errorCode: 'extraction-or-write-failed' })
    expect(disk.load()).not.toContain('sensitive raw error')
    await writer.resumePendingCaptures()
    expect(extract).toHaveBeenCalledTimes(1)
    await writer.resumePendingCaptures(true)
    await writer.resumePendingCaptures(true)
    expect(extract).toHaveBeenCalledTimes(2)
    expect(repository.snapshot().tasks[0]?.status).toBe('failed')
  })

  it('does not run the extractor when the durable registration fails', async () => {
    const extract = vi.fn(() => [])
    const repository = createCaptureRepository({ persistence: { load: () => undefined, save: () => { throw new Error('disk full') } } })
    const writer = createMemoryWriter({ store: createVectorStore(), captureRepository: repository, extractor: extract })
    await expect(writer.capture(turn(), scope)).rejects.toThrow('disk full')
    expect(extract).not.toHaveBeenCalled()
    expect(repository.snapshot().sources).toHaveLength(0)
  })

  it('rejects oversized input explicitly instead of silently truncating it', () => {
    const repository = createCaptureRepository({ persistence: persistence() })
    expect(() => repository.register(turn('字'.repeat(100_001)), scope, 'v1')).toThrow('100000')
    expect(repository.snapshot().sources).toHaveLength(0)
  })

  it('rejects corrupt snapshots and never replaces them with an empty inbox', () => {
    const disk = persistence()
    disk.save('{"version":99,"sources":[],"tasks":[]}')
    expect(() => createCaptureRepository({ persistence: disk })).toThrow('Invalid capture')
    expect(disk.load()).toContain('99')
  })

  it('stores images and contextual inputs for faithful replay and erases them on deletion', () => {
    const repository = createCaptureRepository({ persistence: persistence() })
    const input = { ...turn(), context: { recentMessages: [{ id: 'context-id', role: 'user' as const, content: '上下文' }] },
      attachments: [{ type: 'image' as const, data: 'base64-image', mimeType: 'image/png', id: 'image-id' }] }
    const task = repository.register(input, scope, 'v1')[0]!
    expect(repository.claim(task.id)?.turn.attachments).toEqual(input.attachments)
    repository.invalidate(scope, ['context-id'])
    expect(repository.snapshot().sources[0]?.turn).toBeUndefined()
    expect(repository.snapshot().tasks[0]?.status).toBe('cancelled')
    expect(repository.pending('v1', true)).toHaveLength(0)
  })

  it('deduplicates concurrent calls and never executes a task twice', async () => {
    const repository = createCaptureRepository({ persistence: persistence() })
    const extract = vi.fn(() => [])
    const writer = createMemoryWriter({ store: createVectorStore(), captureRepository: repository, extractor: extract })
    await Promise.all([writer.capture(turn(), scope), writer.capture(turn(), scope), writer.resumePendingCaptures()])
    await writer.flushPendingCaptures()
    expect(extract).toHaveBeenCalledTimes(1)
  })

  it.each(['unlink', 'clear'] as const)('prevents active work from resurrecting deleted sources via %s', async (operation) => {
    const repository = createCaptureRepository({ persistence: persistence() })
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    const writer = createMemoryWriter({
      store: createVectorStore(), captureRepository: repository,
      extractor: async () => {
        started()
        await blocked
        return [{ content: '用户姓名/名字：小秦', metadata: { kind: 'identity', confidence: 0.95, extractionChannel: 'rules' } }]
      },
    })
    const capturing = writer.capture(turn('我叫小秦'), scope)
    await entered
    const deletion = operation === 'clear' ? writer.clear(scope) : writer.unlinkSources(['message'], scope)
    expect(repository.snapshot().sources[0]?.turn).toBeUndefined()
    release()
    await Promise.all([capturing, deletion])
    await writer.flushPendingCaptures()
    expect(await writer.count(scope)).toBe(0)
    expect(repository.snapshot().tasks[0]?.status).toBe('cancelled')
  })

  it('keeps other owners intact when clearing one scope', () => {
    const repository = createCaptureRepository({ persistence: persistence() })
    repository.register(turn(), scope, 'v1')
    repository.register(turn(), { ...scope, ownerId: 'other' }, 'v1')
    repository.invalidate(scope)
    expect(repository.snapshot().sources.map(source => source.status)).toEqual(['deleted', 'active'])
  })

  it('erases source evidence on irreversible fact purge, including sources without message IDs', async () => {
    const repository = createCaptureRepository({ persistence: persistence() })
    const writer = createMemoryWriter({ store: createVectorStore(), captureRepository: repository })
    await writer.capture({ userMessage: '我叫小秦', assistantMessage: '' }, scope)
    const record = (await writer.list(scope))[0]!
    expect(record).toBeDefined()
    expect(await writer.purge!(record.id, scope)).toBe(true)
    expect(repository.snapshot().sources[0]?.turn).toBeUndefined()
    await writer.resumePendingCaptures(true)
    expect(await writer.count(scope)).toBe(0)
  })

  it('encrypts originals and tasks, and scrubs generic snapshot backups after deletion', () => {
    const directory = mkdtempSync(join(tmpdir(), 'capture-inbox-'))
    directories.push(directory)
    const options = {
      encryptedPath: join(directory, 'captures.enc'), keyPath: join(directory, 'captures.key'),
      // Test-only reversible key protection; desktop uses OS safeStorage.
      protectKey: (key: Buffer) => Buffer.from(key), unprotectKey: (key: Buffer) => Buffer.from(key),
    }
    const disk = createEncryptedFilePersistence(options)
    const repository = createCaptureRepository({ persistence: disk })
    repository.register(turn('敏感原文不进入明文文件'), scope, 'v1')
    disk.backupBeforeMigration?.()
    expect(readFileSync(options.encryptedPath, 'utf8')).not.toContain('敏感原文')
    expect(createCaptureRepository({ persistence: createEncryptedFilePersistence(options) }).snapshot().sources[0]?.turn?.userMessage)
      .toBe('敏感原文不进入明文文件')
    repository.invalidate(scope)
    const backup = createEncryptedFilePersistence({ ...options, encryptedPath: disk.backupPath, journalPath: `${disk.backupPath}.journal` })
    expect(backup.load()).not.toContain('敏感原文')
    expect(createCaptureRepository({ persistence: createEncryptedFilePersistence(options) }).pending('v1')).toHaveLength(0)
  })

  it('recovers the crash window after a fact commit without creating a duplicate fact', async () => {
    const disk = persistence()
    const repository = createCaptureRepository({ persistence: disk })
    const task = repository.register(turn('我叫小秦'), scope, 'v1')[0]!
    const input = repository.claim(task.id)!
    const store = createVectorStore()
    // Simulate a committed fact with no corresponding task completion checkpoint.
    await createMemoryWriter({ store }).capture(input.turn, input.scope)
    expect(await store.count(scope)).toBe(1)
    const recovered = createCaptureRepository({ persistence: disk })
    const writer = createMemoryWriter({ store, captureRepository: recovered, captureProcessorVersion: 'v1' })
    await writer.resumePendingCaptures()
    expect(await store.count(scope)).toBe(1)
    expect((await store.list(scope))[0]?.sourceMessageIds).toEqual(['message'])
    expect(recovered.snapshot().tasks[0]?.status).toBe('succeeded')
  })

  it('purges all anonymous sources contributing to one merged fact', async () => {
    const repository = createCaptureRepository({ persistence: persistence() })
    const writer = createMemoryWriter({ store: createVectorStore(), captureRepository: repository })
    await writer.capture({ userMessage: '我叫小秦', assistantMessage: '' }, scope)
    await writer.capture({ userMessage: '我叫小秦', assistantMessage: '' }, scope)
    expect(repository.snapshot().sources).toHaveLength(2)
    const record = (await writer.list(scope))[0]!
    await writer.purge!(record.id, scope)
    expect(repository.snapshot().sources.every(source => !source.turn)).toBe(true)
  })

  it('continues later durable segments when an earlier segment fails', async () => {
    const repository = createCaptureRepository({ persistence: persistence() })
    const writer = createMemoryWriter({ store: createVectorStore(), captureRepository: repository, maximumSegmentCharacters: 256,
      extractor: input => {
        if (input.metadata?.memoryCaptureSegmentIndex === 0) throw new Error('failed')
        return []
      } })
    await writer.capture(turn('长'.repeat(600)), scope)
    await writer.flushPendingCaptures()
    expect(repository.snapshot().tasks.map(task => task.status)).toEqual(['failed', 'succeeded', 'succeeded'])
    expect(writer.captureStatus()).toMatchObject({ retryable: 1, tasks: { failed: 1, succeeded: 2 } })
  })

  it('supersedes an in-flight extraction when the same message is edited', async () => {
    const repository = createCaptureRepository({ persistence: persistence() })
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    const writer = createMemoryWriter({ store: createVectorStore(), captureRepository: repository,
      extractor: async input => {
        if (input.userMessage === '旧文本') { started(); await blocked }
        return []
      } })
    const first = writer.capture(turn('旧文本'), scope)
    await entered
    const second = writer.capture(turn('新文本'), scope)
    release()
    await Promise.all([first, second])
    expect(repository.snapshot().tasks.map(task => task.status)).toEqual(['cancelled', 'succeeded'])
  })

  it('unlinks a record even when deletion arrives inside an asynchronous fact write', async () => {
    const repository = createCaptureRepository({ persistence: persistence() })
    const store = createVectorStore()
    const remember = store.remember
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    store.remember = async (...args) => { started(); await blocked; return remember(...args) }
    const captured = vi.fn()
    const writer = createMemoryWriter({ store, captureRepository: repository, onCaptured: captured })
    const first = writer.capture(turn('我叫小秦'), scope)
    await entered
    const deletion = writer.unlinkSources(['message'], scope)
    release()
    await Promise.all([first, deletion])
    expect((await store.list(scope)).every(record => record.status !== 'active')).toBe(true)
    expect(captured).not.toHaveBeenCalled()
    expect(repository.snapshot().tasks[0]?.status).toBe('cancelled')
  })
})
