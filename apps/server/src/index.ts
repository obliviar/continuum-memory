import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { join } from 'node:path'
import type { AgentRuntime } from '@continuum-memory/core'
import { createAgentRuntime, createSessionManager } from '@continuum-memory/core'
import { createOpenAILlm } from '@continuum-memory/llm-openai'
import { createMemoryWriter, createVectorStore } from '@continuum-memory/memory'
import { createToolRegistry, webSearchTool, fileReadTool, httpFetchTool } from '@continuum-memory/tools'

import { chatRoutes } from './routes/chat'
import { voiceRoutes } from './routes/voice'

export type AppEnv = { Variables: { runtime: AgentRuntime } }

function environmentValue(current: string, legacy: string): string | undefined {
  return process.env[current] ?? process.env[legacy]
}

const config = {
  port: Number(process.env.PORT) || 3000,
  apiKey: process.env.CONTINUUM_MEMORY_API_KEY || process.env.OPENAI_API_KEY || '',
  baseURL: process.env.CONTINUUM_MEMORY_BASE_URL || process.env.OPENAI_BASE_URL || undefined,
  model: environmentValue('CONTINUUM_MEMORY_MODEL', 'DESKPET_MODEL') || 'gpt-4o-mini',
  systemPrompt: environmentValue('CONTINUUM_MEMORY_SYSTEM_PROMPT', 'DESKPET_SYSTEM_PROMPT') || 'You are a helpful AI assistant named Continuum Memory.',
  embeddingApiKey: environmentValue('CONTINUUM_MEMORY_EMBEDDING_API_KEY', 'DESKPET_EMBEDDING_API_KEY') || process.env.CONTINUUM_MEMORY_API_KEY || process.env.OPENAI_API_KEY || '',
  embeddingBaseURL: environmentValue('CONTINUUM_MEMORY_EMBEDDING_BASE_URL', 'DESKPET_EMBEDDING_BASE_URL') || process.env.CONTINUUM_MEMORY_BASE_URL || process.env.OPENAI_BASE_URL || undefined,
  embeddingModel: environmentValue('CONTINUUM_MEMORY_EMBEDDING_MODEL', 'DESKPET_EMBEDDING_MODEL') || 'local-hash-v3',
  memoryPath: environmentValue('CONTINUUM_MEMORY_PATH', 'DESKPET_MEMORY_PATH') || join(process.cwd(), 'data', 'memories.json'),
}

if (!config.apiKey) {
  console.error('[continuum-memory-server] Set CONTINUUM_MEMORY_API_KEY or OPENAI_API_KEY')
  process.exit(1)
}

const llm = createOpenAILlm({ apiKey: config.apiKey, baseURL: config.baseURL })
const session = createSessionManager(200)

let memory: ReturnType<typeof createMemoryWriter> | undefined
if (environmentValue('CONTINUUM_MEMORY_ENABLED', 'DESKPET_MEMORY') !== 'false') {
  const store = createVectorStore({
    apiKey: config.embeddingApiKey,
    baseURL: config.embeddingBaseURL,
    embeddingModel: config.embeddingModel,
    storagePath: config.memoryPath,
  })
  memory = createMemoryWriter({ store })
}

const tools = createToolRegistry([webSearchTool, fileReadTool, httpFetchTool])

const runtime = createAgentRuntime({
  persona: { systemPrompt: config.systemPrompt, model: config.model },
  llm, session, memory, tools,
  // Without authentication, use the session id as the owner boundary to avoid cross-session leaks.
  // Keep the historical agent ID so existing persisted memories remain visible after the rename.
  resolveMemoryScope: sessionId => ({ ownerId: sessionId, agentId: 'deskpet' }),
})

const app = new Hono<AppEnv>()

app.get('/health', (c) => c.json({ status: 'ok' }))

app.use('*', async (c, next) => {
  c.set('runtime', runtime)
  await next()
})

app.route('/chat', chatRoutes)
app.route('/voice', voiceRoutes)

console.log(`[continuum-memory-server] starting on http://localhost:${config.port}`)
console.log(`[continuum-memory-server] model: ${config.model}, tools: ${tools.definitions().map(d => d.function.name).join(', ')}`)

serve({ fetch: app.fetch, port: config.port })
