import type {
  AgentLLMPort,
  AgentMemoryPort,
  ChatMessage,
  MemoryCapture,
  MemoryScope,
  StreamEvent,
} from '@continuum-memory/contracts'
import { describe, expect, it } from 'vitest'
import { createSessionManager } from '../session/session-manager'
import { createAgentRuntime } from './agent-runtime'

describe('agent runtime memory safety', () => {
  it('sends current image attachments to the model without persisting base64 in session history', async () => {
    const observed: ChatMessage[][] = []
    const session = createSessionManager(10)
    const runtime = createAgentRuntime({
      persona: { systemPrompt: 'test', model: 'test' },
      llm: createLlm([{ type: 'text-delta', text: 'ok' }], observed),
      session,
    })

    await runtime.send('s', '看看这张图', {
      attachments: [{ type: 'image', data: 'base64-image', mimeType: 'image/png' }],
      input: { type: 'image' },
    })

    const sentUser = observed[0]?.find(message => message.role === 'user')
    expect(sentUser?.content).toEqual([
      { type: 'text', text: '看看这张图' },
      { type: 'image', data: 'base64-image', mimeType: 'image/png' },
    ])
    expect(session.getSessionMessages('s')[0]?.content).toBe('看看这张图')
  })

  it('commits user facts even when the model request fails', async () => {
    const memory = createMemorySpy()
    const session = createSessionManager(10)
    const runtime = createAgentRuntime({
      persona: { systemPrompt: 'test', model: 'test' },
      llm: createLlm([{ type: 'error', error: new Error('offline') }]),
      session,
      memory: memory.port,
    })

    await expect(runtime.send('s', '我叫小秦')).rejects.toThrow('offline')
    expect(memory.captures).toHaveLength(1)
    expect(memory.captures[0]?.assistantMessage).toBe('')
    expect(memory.captures[0]?.metadata?.sourceMessageIds).toHaveLength(1)
    expect(session.getSessionMessages('s').map(message => message.role)).toEqual(['user'])
  })

  it('keeps long-term sources when the bounded session only evicts old messages', async () => {
    const memory = createMemorySpy()
    const session = createSessionManager(2)
    const runtime = createAgentRuntime({
      persona: { systemPrompt: 'test', model: 'test' },
      llm: createLlm([{ type: 'text-delta', text: 'ok' }]),
      session,
      memory: memory.port,
    })

    await runtime.send('s', 'first')
    const firstTurnIds = session.getSessionMessages('s').map(message => message.id)
    await runtime.send('s', 'second')

    expect(firstTurnIds).toHaveLength(2)
    expect(memory.unlinked).toEqual([])
    expect(session.getSessionMessages('s').map(message => message.content)).toEqual(['second', 'ok'])
  })

  it('uses adaptive recall by default and fixed recall when memoryTopK is explicit', async () => {
    const calls: string[] = []
    const memory = createMemorySpy()
    memory.port.recall = async (_query, _scope, topK) => {
      calls.push(`fixed:${String(topK)}`)
      return []
    }
    memory.port.recallAdaptive = async () => {
      calls.push('adaptive')
      return {
        memories: [], retrievedMemoryIds: [], injectedMemoryIds: [],
        candidateCount: 0, evaluatedCount: 0, batchesEvaluated: 0,
        stopReason: 'no-candidates',
      }
    }
    const runtime = createAgentRuntime({
      persona: { systemPrompt: 'test', model: 'test' },
      llm: createLlm([{ type: 'text-delta', text: 'ok' }]),
      session: createSessionManager(10),
      memory: memory.port,
    })

    await runtime.send('adaptive-session', 'first')
    await runtime.send('fixed-session', 'second', { memoryTopK: 7 })

    expect(calls).toEqual(['adaptive', 'fixed:7'])
  })

  it('reports adopted and ignored citation outcomes after the answer completes', async () => {
    const memory = createMemorySpy()
    memory.port.recallAdaptive = async () => ({
      memories: [
        { id: 'memory-1', content: '用户姓名：小秦', createdAt: 1 },
        { id: 'memory-2', content: '用户所在地：北京', createdAt: 1 },
      ],
      retrievedMemoryIds: ['memory-1', 'memory-2'],
      injectedMemoryIds: ['memory-1', 'memory-2'],
      candidateCount: 2,
      evaluatedCount: 2,
      batchesEvaluated: 1,
      stopReason: 'max-injected',
      evidencePack: [
        { memoryId: 'memory-1', citation: 'M1' },
        { memoryId: 'memory-2', citation: 'M2' },
      ],
    })
    const reports: unknown[] = []
    memory.port.reportRecallFeedback = async (report) => {
      reports.push(report)
    }
    const observed: ChatMessage[][] = []
    const runtime = createAgentRuntime({
      persona: { systemPrompt: 'test', model: 'test-model' },
      llm: createLlm([{ type: 'text-delta', text: '你叫小秦 [M1]。' }], observed),
      session: createSessionManager(10),
      memory: memory.port,
    })

    await runtime.send('s', '我叫什么名字')

    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      query: '我叫什么名字',
      answerModel: 'test-model',
      outcomes: [
        { memoryId: 'memory-1', outcome: 'adopted' },
        { memoryId: 'memory-2', outcome: 'ignored' },
      ],
    })
    const system = observed[0]?.find(message => message.role === 'system')?.content
    expect(system).toContain('id="M1"')
    expect(system).toContain('bracketed id')
  })

  it('records an explicit uniquely matched user correction without treating other memories as denied', async () => {
    const memory = createMemorySpy()
    memory.port.recallAdaptive = async () => ({
      memories: [
        { id: 'memory-city', content: '用户所在地：北京', createdAt: 1 },
        { id: 'memory-drink', content: '用户喜欢咖啡', createdAt: 1 },
      ],
      retrievedMemoryIds: ['memory-city', 'memory-drink'],
      injectedMemoryIds: ['memory-city', 'memory-drink'],
      candidateCount: 2, evaluatedCount: 2, batchesEvaluated: 1, stopReason: 'max-injected',
      evidencePack: [
        { memoryId: 'memory-city', citation: 'M1' },
        { memoryId: 'memory-drink', citation: 'M2' },
      ],
    })
    const reports: Array<{ outcomes: Array<{ memoryId: string; outcome: string }> }> = []
    memory.port.reportRecallFeedback = async (report) => {
      reports.push(report)
    }
    const runtime = createAgentRuntime({
      persona: { systemPrompt: 'test', model: 'test-model' },
      llm: createLlm([{ type: 'text-delta', text: '明白，已经更正。[M1]' }]),
      session: createSessionManager(10),
      memory: memory.port,
    })

    await runtime.send('s', '不是北京而是杭州，请更正我的所在地')

    expect(reports[0]?.outcomes).toEqual([
      { memoryId: 'memory-city', outcome: 'corrected' },
      { memoryId: 'memory-drink', outcome: 'ignored' },
    ])
  })

  it('records only a strong explicit denial that uniquely matches injected evidence', async () => {
    const memory = createMemorySpy()
    memory.port.recallAdaptive = async () => ({
      memories: [{ id: 'memory-allergy', content: '用户对花生过敏', createdAt: 1 }],
      retrievedMemoryIds: ['memory-allergy'], injectedMemoryIds: ['memory-allergy'],
      candidateCount: 1, evaluatedCount: 1, batchesEvaluated: 1, stopReason: 'max-injected',
      evidencePack: [{ memoryId: 'memory-allergy', citation: 'M1' }],
    })
    const reports: Array<{ outcomes: Array<{ memoryId: string; outcome: string }> }> = []
    memory.port.reportRecallFeedback = async (report) => {
      reports.push(report)
    }
    const runtime = createAgentRuntime({
      persona: { systemPrompt: 'test', model: 'test-model' },
      llm: createLlm([{ type: 'text-delta', text: '我会按你的要求处理。' }]),
      session: createSessionManager(10),
      memory: memory.port,
    })

    await runtime.send('s', '我从来没说过我对花生过敏，删除这条记忆')

    expect(reports[0]?.outcomes).toEqual([{ memoryId: 'memory-allergy', outcome: 'denied' }])
  })
})

function createLlm(events: StreamEvent[], observed: ChatMessage[][] = []): AgentLLMPort {
  return {
    async *stream(_model, messages) {
      observed.push(messages)
      for (const event of events)
        yield event
    },
  }
}

function createMemorySpy() {
  const captures: MemoryCapture[] = []
  const unlinked: string[][] = []
  const port: AgentMemoryPort = {
    async list() { return [] },
    async recall() { return [] },
    async remember() {},
    async capture(turn) {
      captures.push(turn)
      return 0
    },
    async forget() {},
    async update() { return true },
    async restore() { return true },
    async unlinkSources(messageIds: string[], _scope: MemoryScope) {
      unlinked.push(messageIds)
      return { updated: messageIds.length, orphaned: messageIds.length }
    },
    async clear() {},
    async count() { return 0 },
  }
  return { captures, unlinked, port }
}

describe('historical message references', () => {
  it('sends attributed quotations to the model while capturing only the new user statement', async () => {
    const memory = createMemorySpy(), session = createSessionManager(10), observed: ChatMessage[][] = []
    session.ensureSession('quoted')
    session.appendSessionMessage('quoted', { id: 'old-answer', role: 'assistant', content: '未经核实的旧回答', createdAt: 1 })
    const runtime = createAgentRuntime({ persona: { systemPrompt: 'test', model: 'test' },
      llm: createLlm([{ type: 'text-delta', text: '收到' }], observed), session, memory: memory.port })
    await runtime.send('quoted', '这句话的依据是什么？', { quote: { messageId: 'old-answer', role: 'assistant', content: '未经核实的旧回答' } })
    const sent = observed[0]?.filter(message => message.role === 'user').at(-1)
    expect(sent?.content).toContain('引用的历史助手消息')
    expect(sent?.content).toContain('未经核实的旧回答')
    expect(memory.captures[0]?.userMessage).toBe('这句话的依据是什么？')
    const user = session.getSessionMessages('quoted').find(message => message.role === 'user')
    expect(user?.content).toBe('这句话的依据是什么？')
    expect(user?.quote?.messageId).toBe('old-answer')
    await runtime.send('quoted', '继续解释')
    expect(observed[1]?.some(message => typeof message.content === 'string' && message.content.includes('引用的历史助手消息'))).toBe(true)
    expect(memory.captures.at(-1)?.userMessage).toBe('继续解释')
  })
  it('rejects a reference from another session before saving new evidence', async () => {
    const memory = createMemorySpy(), session = createSessionManager(10)
    session.ensureSession('other')
    session.appendSessionMessage('other', { id: 'foreign', role: 'assistant', content: '其他对话的内容', createdAt: 1 })
    const runtime = createAgentRuntime({ persona: { systemPrompt: 'test', model: 'test' },
      llm: createLlm([{ type: 'text-delta', text: '收到' }]), session, memory: memory.port })
    await expect(runtime.send('current', '解释', { quote: { messageId: 'foreign', role: 'assistant', content: '其他对话的内容' } })).rejects.toThrow('not available in this session')
    expect(memory.captures).toHaveLength(0)
    expect(session.getSessionMessages('current')).toHaveLength(0)
  })
})

describe('stopping and retrying a response', () => {
  it('stops an awaiting stream, preserves partial output, and retries without duplicating user evidence', async () => {
    const memory = createMemorySpy(), session = createSessionManager(20), controller = new AbortController()
    let calls = 0, started!: () => void
    const firstToken = new Promise<void>(resolve => { started = resolve })
    const llm: AgentLLMPort = { async *stream(_model, _messages, options) {
      calls++
      if (calls === 1) {
        yield { type: 'text-delta', text: '已输出的部分' }
        started()
        await new Promise<void>(resolve => { if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener('abort', () => resolve(), { once: true }) })
        yield { type: 'error', error: new Error('aborted') }
      } else yield { type: 'text-delta', text: '完整的新回答' }
    } }
    const runtime = createAgentRuntime({ persona: { systemPrompt: 'test', model: 'test' }, llm, session, memory: memory.port })
    const pending = runtime.send('s', '我的项目叫星河。', { signal: controller.signal })
    await firstToken
    controller.abort()
    const stopped = await pending
    expect(stopped).toMatchObject({ text: '已输出的部分', stopped: true, toolCalls: [] })
    expect(session.getSessionMessages('s').at(-1)).toMatchObject({ status: 'stopped', replyTo: stopped.userMessageId })
    const retried = await runtime.send('s', '我的项目叫星河。', { retryUserMessageId: stopped.userMessageId })
    expect(retried.text).toBe('完整的新回答')
    expect(session.getSessionMessages('s').filter(message => message.role === 'user')).toHaveLength(1)
    expect(memory.captures).toHaveLength(1)
  })
  it('does not execute pending tool calls after cancellation', async () => {
    const controller = new AbortController(), executed: string[] = []
    const llm: AgentLLMPort = { async *stream() { yield { type: 'tool-call', id: 't', name: 'write', arguments: '{}' }; controller.abort() } }
    const runtime = createAgentRuntime({ persona: { systemPrompt: 'test', model: 'test' }, llm, session: createSessionManager(10),
      tools: { hasTools: () => true, definitions: () => [], execute: async name => { executed.push(name); return { content: 'done', toolCallId: 't' } } } })
    expect((await runtime.send('s', '操作', { signal: controller.signal })).stopped).toBe(true)
    expect(executed).toEqual([])
  })
  it('rejects retry of an old question after a newer turn without adding evidence', async () => {
    const memory = createMemorySpy(), session = createSessionManager(10)
    session.ensureSession('s')
    session.appendSessionMessage('s', { id: 'old', role: 'user', content: '旧问题', createdAt: 1 })
    session.appendSessionMessage('s', { id: 'new', role: 'user', content: '新问题', createdAt: 2 })
    const runtime = createAgentRuntime({ persona: { systemPrompt: 'test', model: 'test' }, llm: createLlm([]), session, memory: memory.port })
    await expect(runtime.send('s', '旧问题', { retryUserMessageId: 'old' })).rejects.toThrow('latest failed or stopped')
    expect(memory.captures).toEqual([])
  })
})
