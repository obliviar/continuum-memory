import { describe, expect, it } from 'vitest'
import type { SourceRecallEvidence } from '@continuum-memory/contracts'
import { createAgentRuntime } from './agent-runtime'
import { createSessionManager } from '../session/session-manager'

describe('source evidence in model messages', () => {
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
