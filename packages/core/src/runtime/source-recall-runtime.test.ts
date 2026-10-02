import { describe, expect, it } from 'vitest'
import type { SourceRecallEvidence } from '@continuum-memory/contracts'
import type { AgentMemoryPort } from '@continuum-memory/contracts'
import { createAgentRuntime } from './agent-runtime'
import { createSessionManager } from '../session/session-manager'

describe('source evidence in model messages', () => {
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
