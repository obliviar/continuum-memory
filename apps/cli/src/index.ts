import { createAgentRuntime, createSessionManager, createChatHooks } from '@continuum-memory/core'
import { createOpenAILlm } from '@continuum-memory/llm-openai'
import { createMemoryWriter, createVectorStore } from '@continuum-memory/memory'
import { createToolRegistry, webSearchTool, fileReadTool, httpFetchTool } from '@continuum-memory/tools'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from './config'
import { startChatRepl } from './commands/chat'

const config = loadConfig()

const llm = createOpenAILlm({ apiKey: config.openaiApiKey, baseURL: config.baseURL, provider: config.provider })
const session = createSessionManager(config.maxHistory ?? 100)

const hooks = createChatHooks()
hooks.onTokenLiteral(async (literal) => {
  process.stdout.write(literal)
})
hooks.onStreamEnd(async () => {
  process.stdout.write('\n')
})

let memory: ReturnType<typeof createMemoryWriter> | undefined
if (config.memoryEnabled) {
  const currentDefaultMemoryPath = join(homedir(), '.continuum-memory', 'memories.json')
  const legacyDefaultMemoryPath = join(homedir(), '.deskpet', 'memories.json')
  const defaultMemoryPath = existsSync(currentDefaultMemoryPath) || !existsSync(legacyDefaultMemoryPath)
    ? currentDefaultMemoryPath
    : legacyDefaultMemoryPath
  const store = createVectorStore({
    apiKey: config.embeddingApiKey,
    baseURL: config.embeddingBaseURL,
    embeddingModel: config.embeddingModel,
    storagePath: config.memoryPath ?? defaultMemoryPath,
  })
  memory = createMemoryWriter({ store })
}

const tools = createToolRegistry([webSearchTool, fileReadTool, httpFetchTool])

const runtime = createAgentRuntime({
  persona: {
    systemPrompt: config.systemPrompt ?? 'You are a helpful AI assistant named Continuum Memory.',
    model: config.model,
  },
  llm,
  session,
  memory,
  // Keep the historical agent ID so existing persisted memories remain visible after the rename.
  resolveMemoryScope: () => ({ ownerId: config.memoryOwnerId ?? 'local-user', agentId: 'deskpet' }),
  tools,
  hooks,
})

console.log(`[continuum-memory] Ready. Model: ${config.model}, Provider: ${config.provider ?? 'openai'}`)
console.log(`[continuum-memory] Tools: ${tools.definitions().map(d => d.function.name).join(', ')}`)
console.log('[continuum-memory] Type /help for commands, Ctrl+C to exit.\n')

startChatRepl(runtime, config.defaultSession ?? 'default')
