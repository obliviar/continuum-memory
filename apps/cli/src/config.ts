import type { ProviderPreset } from '@continuum-memory/llm-openai'

export interface ContinuumMemoryConfig {
  openaiApiKey: string
  baseURL?: string
  provider?: ProviderPreset
  model: string
  systemPrompt?: string
  maxHistory?: number
  defaultSession?: string
  memoryEnabled?: boolean
  memoryPath?: string
  memoryOwnerId?: string
  embeddingApiKey?: string
  embeddingBaseURL?: string
  embeddingModel?: string
  tools?: string[]
}

function environmentValue(current: string, legacy: string): string | undefined {
  return process.env[current] ?? process.env[legacy]
}

export function loadConfig(): ContinuumMemoryConfig {
  const apiKey = process.env.CONTINUUM_MEMORY_API_KEY || process.env.OPENAI_API_KEY || process.env.API_KEY || ''
  if (!apiKey) {
    console.error('[continuum-memory] Set CONTINUUM_MEMORY_API_KEY or OPENAI_API_KEY')
    process.exit(1)
  }

  return {
    openaiApiKey: apiKey,
    baseURL: process.env.CONTINUUM_MEMORY_BASE_URL || process.env.OPENAI_BASE_URL || undefined,
    provider: (environmentValue('CONTINUUM_MEMORY_PROVIDER', 'DESKPET_PROVIDER') as ProviderPreset) || undefined,
    model: environmentValue('CONTINUUM_MEMORY_MODEL', 'DESKPET_MODEL') || 'gpt-4o-mini',
    systemPrompt: environmentValue('CONTINUUM_MEMORY_SYSTEM_PROMPT', 'DESKPET_SYSTEM_PROMPT'),
    maxHistory: environmentValue('CONTINUUM_MEMORY_MAX_HISTORY', 'DESKPET_MAX_HISTORY')
      ? Number(environmentValue('CONTINUUM_MEMORY_MAX_HISTORY', 'DESKPET_MAX_HISTORY'))
      : 100,
    defaultSession: environmentValue('CONTINUUM_MEMORY_SESSION', 'DESKPET_SESSION') || 'default',
    memoryEnabled: environmentValue('CONTINUUM_MEMORY_ENABLED', 'DESKPET_MEMORY') !== 'false',
    memoryPath: environmentValue('CONTINUUM_MEMORY_PATH', 'DESKPET_MEMORY_PATH'),
    memoryOwnerId: environmentValue('CONTINUUM_MEMORY_OWNER', 'DESKPET_MEMORY_OWNER') || 'local-user',
    embeddingApiKey: environmentValue('CONTINUUM_MEMORY_EMBEDDING_API_KEY', 'DESKPET_EMBEDDING_API_KEY') || apiKey,
    embeddingBaseURL: environmentValue('CONTINUUM_MEMORY_EMBEDDING_BASE_URL', 'DESKPET_EMBEDDING_BASE_URL') || process.env.OPENAI_BASE_URL || undefined,
    embeddingModel: environmentValue('CONTINUUM_MEMORY_EMBEDDING_MODEL', 'DESKPET_EMBEDDING_MODEL') || 'local-hash-v3',
    tools: environmentValue('CONTINUUM_MEMORY_TOOLS', 'DESKPET_TOOLS')?.split(',').map(t => t.trim()),
  }
}
