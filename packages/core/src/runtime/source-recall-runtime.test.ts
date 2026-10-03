import { describe, expect, it } from 'vitest'
import type { SourceRecallEvidence } from '@continuum-memory/contracts'
import type { AgentMemoryPort } from '@continuum-memory/contracts'
import { createAgentRuntime } from './agent-runtime'
import { createSessionManager } from '../session/session-manager'

describe('source evidence in model messages', () => {
  it('allows a bounded document workflow with six tool steps to finish its answer', async () => {
    let round = 0, executed = 0
    const runtime = createAgentRuntime({ persona: { systemPrompt: 'test', model: 'test' }, session: createSessionManager(10), maxToolRounds: 10,
      tools: { hasTools: () => true, definitions: () => [], execute: async () => { executed++; return { toolCallId: '', content: 'step completed' } } },
      llm: { async *stream() {
        if (round++ < 6) yield { type: 'tool-call', id: `step-${round}`, name: 'document_step', arguments: '{}' } as const
        else yield { type: 'text-delta', text: 'document ready' } as const
      } },
    })
    expect((await runtime.send('s', '创建文档')).text).toBe('document ready')
    expect(executed).toBe(6)
  })
  it('uses a selected workflow for one turn without storing its instructions as chat or memory evidence', async () => {
    const session = createSessionManager(10), prompts: any[][] = [], captures: string[] = []
    const runtime = createAgentRuntime({ persona: { systemPrompt: 'test', model: 'test' }, session,
      memory: { recall: async () => [], enqueueCapture: async (input: { userMessage: string }) => { captures.push(input.userMessage) } } as unknown as AgentMemoryPort,
      llm: { async *stream(_model, messages) { prompts.push(structuredClone(messages)); yield { type: 'text-delta', text: 'ok' } as const } },
    })
    await runtime.send('s', '总结这段文本', { skill: { id: 'builtin:summary', payload: 'WORKFLOW_GUIDANCE_ONLY' } })
    expect(prompts[0]?.some(m => m.role === 'tool' && m.name === 'use_skill' && m.content === 'WORKFLOW_GUIDANCE_ONLY')).toBe(true)
    expect(captures).toEqual(['总结这段文本'])
    expect(JSON.stringify(session.getSessionMessages('s'))).not.toContain('WORKFLOW_GUIDANCE_ONLY')
    await runtime.send('s', '下一轮普通问题')
    expect(JSON.stringify(prompts[1])).not.toContain('WORKFLOW_GUIDANCE_ONLY')
  })
  it('retries a transient published-view conflict without waiting for extraction or fabricating graph facts', async () => {
    let attempts = 0
    const memory = { capture: async () => 0, graph: { recall: async () => { attempts++; return {
      ok: false, error: { code: 'stale-projection', message: 'background publication' },
    } } } } as unknown as AgentMemoryPort
    const runtime = createAgentRuntime({ persona: { systemPrompt: 'test', model: 'test' }, memory, session: createSessionManager(10),
      resolveMemoryScope: () => ({ ownerId: 'o', agentId: 'a' }),
      graphRecall: { countTokens: text => text.length, awaitCaptureWrites: async () => {}, createRequest: query => ({
        protocolVersion: 'memory-graph/v1', recallId: 'test', query, scope: { ownerId: 'o', agentId: 'a' },
        temporal: { knownAt: 1, valid: { kind: 'at', at: 1 } }, mode: 'direct-only', sharePolicies: ['allow-remote'], sensitivities: ['normal'],
        budget: { maxSeeds: 1, maxNodes: 1, maxEdges: 0, maxHops: 0, maxRuleBindings: 0, maxProofSteps: 0, maxElapsedMs: 100, maxEvidenceTokens: 4000 },
      }) },
      llm: { async *stream(_model, messages) { expect(String(messages[0]!.content)).toContain('Do not invent remembered facts');
        yield { type: 'text-delta', text: 'ok' } as const } },
    })
    expect((await runtime.send('s', 'question')).text).toBe('ok')
    expect(attempts).toBe(2)
  })
  it('streams and completes while extraction is unresolved, with a per-turn visibility fence', async () => {
    let extracted = false, release!: () => void
    const processing = new Promise<number>(resolve => { release = () => { extracted = true; resolve(1) } })
    let injected = false
    const memory = { capture: () => processing, recall: async () => [], recallAdaptive: undefined } as unknown as AgentMemoryPort
    const runtime = createAgentRuntime({ persona: { systemPrompt: 'test', model: 'test' }, session: createSessionManager(10), memory,
      sourceRecall: { countTokens: t => t.length, maxTokens: 4000, recall: async () => [],
        beginTurn: () => { const eligible = extracted; return async () => {
          injected = eligible
          return []
        } } },
      llm: { async *stream() { expect(extracted).toBe(false); yield { type: 'text-delta', text: 'answer' } as const } },
    })
    expect((await runtime.send('s', 'new fact')).text).toBe('answer')
    expect(injected).toBe(false)
    release()
    await processing
  })
  it('injects raw quotations, treats paths only as navigation and refreshes after tools', async () => {
    const prompts: string[] = []
    let active = true, round = 0
    const entry: SourceRecallEvidence = { citation: 'S1', content: '如果设备修好，样品S7放在恒温箱B2。',
      source: { captureId: 'c', revision: 1, contentHash: 'hash', start: 0, end: 23 },
      recordedAt: 1, scope: { ownerId: 'o', agentId: 'a' }, path: [] }
    entry.source.end = entry.content.length
    const runtime = createAgentRuntime({ persona: { systemPrompt: 'test', model: 'test' }, session: createSessionManager(10),
      resolveMemoryScope: () => ({ ownerId: 'o', agentId: 'a' }),
      sourceRecall: { countTokens: t => t.length, maxTokens: 4000, recall: async () => active ? [structuredClone(entry)] : [] },
      llm: { async *stream(_model, messages) {
        prompts.push(String(messages[0]!.content))
        if (round++ === 0) yield { type: 'tool-call', id: 't', name: 'remove', arguments: '{}' } as const
        else yield { type: 'text-delta', text: 'ok' } as const
      } },
      tools: { hasTools: () => true, definitions: () => [],
        execute: async () => { active = false; return { toolCallId: 't', content: 'removed' } } },
    })
    await runtime.send('s', '样品S7')
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain(entry.content)
    expect(prompts[0]).toContain('Paths explain discovery')
    expect(prompts[1]).not.toContain(entry.content)
  })
})
