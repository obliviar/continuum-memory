import { app, BrowserWindow, ipcMain, desktopCapturer, powerMonitor, safeStorage, shell, dialog } from 'electron'
import { createDesktopSkillService } from './skills'
import { createDocumentService, probeDocumentRuntime, type DocumentRuntime } from './documents'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { runBackgroundTaskBatch } from './background-task-batch'
import { createConversationRegistry, type DesktopConversation } from './conversation-registry'
import { createLocalGraphEvidenceSelection } from './graph-evidence-selection'
import { isGraphExtractionEnabled, shouldPersistGraphExtraction } from './graph-extraction-policy'

import { createAgentRuntime, createSessionManager, createChatHooks, createLLMGraphAnswerabilityReviewer } from '@continuum-memory/core'
import { createOpenAILlm } from '@continuum-memory/llm-openai'
import {
  createEncryptedFilePersistence,
  createEncryptedGraphL1Persistence,
  createV4L2Memory,
  prepareV4EntityVectors,
  createEncryptedGraphRelationPersistence,
  diagnoseV4GraphInputs,
  V4_L2_BUDGET,
  selectRetrievableGraphBundle,
  createEncryptedV4Persistence,
  createIdleConsolidationRunner,
  createJournaledV4Persistence,
  auditV3V4Consistency,
  createMemoryConsolidationService,
  createMemoryTieringService,
  createMemoryV4LifecycleService,
  createMemoryV4ShadowEvaluationStore,
  createMemoryV4ShadowTaskQueue,
  createV3V4ShadowComparator,
  evaluateMemoryV4FeedbackCalibrationGate,
  evaluateMemoryV4RolloutGate,
  mergeDuplicateEpisodes,
  createMemoryCandidateReviewService,
  createMemoryEmbeddingIndex,
  createLocalMemoryCandidateVerifier,
  createMemoryPurgeConfirmationGate,
  createMemoryV4Repository,
  createMemoryWriter,
  createCaptureRepository,
  createSmartMemoryExtractor,
  createOpenGraphExtractor,
  createUieRuleFallbackExtractor,
  planUieSchema,
  createGraphExtractionResultStore,
  createGraphNormalizationStore,
  recoverGraphClaimReviews,
  graphSourcesWithoutFactCandidates,
  normalizeGraphExtraction,
  graphEntityVectorCandidates,
  assessGraphClaim,
  confirmGraphClaim,
  rejectGraphClaim,
  deferGraphClaim,
  setGraphUseAssessment,
  createGraphL1Store,
  createGraphL1Writer,
  parseGraphTimeInterval,
  createGraphSemanticRepository,
  projectOpenAssertions,
  recallOpenSources,
  needsOpenFactRepresentation,
  searchOpenAssertionsWithContext,
  canNavigateOpenAssertion,
  parseUieExtractionTargets,
  createGraphL1ProjectionRepository,
  reviewGraphAdmission,
  createGraphRelationTaskQueue,
  createGraphRelationRepository,
  rebaseGraphRelations,
  stageGraphRelationTasks,
  publishReviewedGraphRelation,
  createGraphPredicateRegistry,
  createBasicGraphRelationRegistry,
  type BasicGraphRelationRegistry,
  createGraphSemanticWorkflow,
  completeGraphSemanticJson,
  GRAPH_SEMANTIC_WORKFLOW_VERSION,
  renderSourceStatementComparison,
  type GraphSemanticWorkflow,
  confirmGraphFactIdentities,
  autoNormalizeUieGraphFact,
  reassessRetainedUieGraphFacts,
  createV4ShadowWriter,
  createVectorStore,
  extractMemoryCandidates,
  fitIsotonicMemoryConfidenceCalibrator,
  freezeMemoryV4InternalFeedbackDataset,
  inferMemoryPrivacy,
  isSafeMemoryContent,
  LOCAL_HASH_EMBEDDING_MODEL,
  migrateV3SourceIntoV4,
} from '@continuum-memory/memory'
import { isUserSourceWithdrawal } from './source-recall-review-policy'
import type {
  JournaledV4Persistence,
  EncryptedMemoryPersistence,
  IdleConsolidationRunner,
  MemoryCandidate,
  MemoryExtractor,
  GraphExtractionResultStore,
  GraphNormalizationStore,
  GraphL1Store,
  CaptureRepository,
  GraphL1Writer,
  GraphSemanticRepository,
  GraphL1ProjectionRepository,
  GraphAdmissionChoices,
  GraphRelationTaskQueue,
  GraphRelationRepository,
  GraphExtractionRun,
  MemoryV4LifecycleService,
  MemoryCandidateReviewService,
  MemoryEmbeddingIndex,
  MemoryV4Repository,
  MemoryV4SemanticIndexSnapshot,
  MemoryV4Snapshot,
  MemoryV4ShadowEvaluationStore,
  MemoryV4ShadowTaskQueue,
  V3V4ShadowComparator,
  VectorStore,
  V4ShadowWriter,
} from '@continuum-memory/memory'
import { createToolRegistry, webSearchTool, fileReadTool, httpFetchTool } from '@continuum-memory/tools'

import { createPersistence } from './persist'
import { withGraphSourceInvalidation } from './graph-source-invalidation'
import { prepareGraphRecallInputs } from './graph-l1-recall-barrier'
import { createSettingsManager } from './settings'
import { setupVoiceIPC } from './voice'
import { createImageMemoryService, isExplicitImageMemoryRequest } from './image-memory'
import {
  createSemanticMemoryService,
  SEMANTIC_MEMORY_FINGERPRINT,
  SEMANTIC_MEMORY_EXPECTED_DIMENSION,
  SEMANTIC_MEMORY_MODEL,
} from './semantic-memory'
import type { SemanticModelProgress } from './semantic-memory'
import {
  createMemoryV4ShadowWorkerClient,
  type MemoryV4ShadowWorkerClient,
} from './memory-v4-shadow-worker-client'
import { createMemoryV4InternalReviewController } from './memory-v4-internal-review'
import {
  createMemoryV4InternalFeedbackStore,
  isMemoryV4InternalFeedbackLabel,
  type MemoryV4InternalFeedbackStore,
} from './memory-v4-internal-feedback'
import { buildMemoryV4SemanticIndexSnapshot } from './memory-v4-semantic-bridge'
import {
  createMemoryV4SemanticBackgroundIndex,
  type MemoryV4SemanticBackgroundIndex,
} from './memory-v4-semantic-index'
import {
  checkMemoryV4RolloutTransition,
  normalizeMemoryV4RolloutStage,
  type MemoryV4RolloutStageSetting,
} from './memory-v4-rollout-settings'
import {
  createMemoryV4ReadController,
  resolveMemoryV4ReadMode,
  type MemoryV4ReadController,
} from './memory-v4-read-controller'
import { createMemoryV4RuntimeObservability } from './memory-v4-runtime-observability'
import { createLocalUieExtractor, uieGraphExtractionRun } from './uie-extractor'
import { createLocalErlangshenNli, ERLANGSHEN_NLI_MODEL_ID,
  ERLANGSHEN_NLI_PREPROCESSING_VERSION } from './local-erlangshen-nli'

// Some Windows systems cannot initialize Electron's GPU subprocess. Disable
// hardware acceleration before app readiness so the packaged app still starts.
app.disableHardwareAcceleration()
app.setName('Continuum Memory')

let mainWindow: BrowserWindow | null = null

function environmentValue(current: string, legacy: string): string | undefined {
  return process.env[current] ?? process.env[legacy]
}

const bootLogPath = environmentValue('CONTINUUM_MEMORY_BOOT_LOG', 'DESKPET_BOOT_LOG')?.trim()
function writeBootLog(message: string) {
  if (!bootLogPath)
    return
  try {
    mkdirSync(dirname(bootLogPath), { recursive: true })
    appendFileSync(bootLogPath, `[${new Date().toISOString()}] ${message}\n`, 'utf-8')
  }
  catch {
    // Diagnostics must not be able to crash the desktop app.
  }
}
process.on('uncaughtException', error => writeBootLog(`uncaughtException: ${error.stack || error.message}`))
process.on('unhandledRejection', error => writeBootLog(`unhandledRejection: ${String(error)}`))
writeBootLog('main module loaded')
const moduleDir = dirname(fileURLToPath(import.meta.url))

// ── Config ────────────────────────────────────────────
function loadFileConfig() {
  const candidates = [
    process.env.PORTABLE_EXECUTABLE_DIR && join(process.env.PORTABLE_EXECUTABLE_DIR, 'config.json'),
    join(dirname(process.execPath), 'config.json'),
    join(app.getAppPath(), '..', 'config.json'),
    join(app.getAppPath(), 'config.json'),
  ].filter((candidate): candidate is string => !!candidate)
  for (const cfgPath of candidates) {
    if (existsSync(cfgPath)) {
      try { return JSON.parse(readFileSync(cfgPath, 'utf-8')) }
      catch { /* try the next candidate */ }
    }
  }
  return {}
}
const fileConfig = loadFileConfig()
function localModelWorkDirectories(): string[] {
  const root = join(process.env.USERPROFILE ?? '', 'Documents', 'Codex')
  const directories = (path: string): string[] => {
    try { return readdirSync(path, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name) }
    catch { return [] }
  }
  return directories(root).flatMap(date => directories(join(root, date))
    .map(task => join(root, date, task, 'work')))
}
function discoverLocalUie(): { modelPath: string; pythonPath: string } | undefined {
  for (const work of localModelWorkDirectories()) {
    const modelPath = join(work, 'uie_base_model')
    const pythonPath = join(work, 'uie_venv', 'Scripts', 'python.exe')
    if (existsSync(join(modelPath, 'model_state.pdparams')) && existsSync(pythonPath))
      return { modelPath, pythonPath }
  }
  return undefined
}
function discoverLocalNli(): { modelPath: string; pythonPath: string; dependenciesPath: string } | undefined {
  for (const work of localModelWorkDirectories()) {
      try {
        const modelRoot = join(work, 'hf_cache', 'hub', 'models--IDEA-CCNL--Erlangshen-Roberta-330M-NLI')
        const revisionFile = join(modelRoot, 'refs', 'main')
        const pythonPath = join(work, 'uie_venv', 'Scripts', 'python.exe')
        if (!existsSync(revisionFile) || !existsSync(pythonPath)) continue
        const revision = readFileSync(revisionFile, 'utf8').trim()
        const modelPath = join(modelRoot, 'snapshots', revision)
        if (!existsSync(join(modelPath, 'pytorch_model.bin'))) continue
        return { modelPath, pythonPath,
          dependenciesPath: [join(work, 'model_deps'), join(work, 'gliner_deps')].join(';') }
      }
      catch { /* Continue to other local snapshots. */ }
  }
  return undefined
}
const discoveredUie = discoverLocalUie()
const discoveredNli = discoverLocalNli()
const memoryEnabledEnvironment = environmentValue('CONTINUUM_MEMORY_ENABLED', 'DESKPET_MEMORY')
const memoryV4ShadowEnvironment = environmentValue('CONTINUUM_MEMORY_V4_SHADOW', 'DESKPET_MEMORY_V4_SHADOW')
const memoryV4InternalReviewEnvironment = environmentValue('CONTINUUM_MEMORY_V4_INTERNAL_REVIEW', 'DESKPET_MEMORY_V4_INTERNAL_REVIEW')

const config = {
  apiKey: process.env.CONTINUUM_MEMORY_API_KEY || process.env.OPENAI_API_KEY || fileConfig.apiKey || '',
  baseURL: process.env.CONTINUUM_MEMORY_BASE_URL || process.env.OPENAI_BASE_URL || fileConfig.baseURL || undefined,
  model: environmentValue('CONTINUUM_MEMORY_MODEL', 'DESKPET_MODEL') || fileConfig.model || 'gpt-4o-mini',
  memoryEnabled: memoryEnabledEnvironment ? memoryEnabledEnvironment !== 'false' : (fileConfig.memoryEnabled !== false),
  memoryV4ShadowEnabled: memoryV4ShadowEnvironment
    ? memoryV4ShadowEnvironment !== 'false'
    : (fileConfig.memoryV4ShadowEnabled !== false),
  memoryV4InternalReviewEnabled: memoryV4InternalReviewEnvironment
    ? memoryV4InternalReviewEnvironment === 'true'
    : (fileConfig.memoryV4InternalReviewEnabled === true),
  memoryV4ReadMode: resolveMemoryV4ReadMode(
    environmentValue('CONTINUUM_MEMORY_V4_READ_MODE', 'DESKPET_MEMORY_V4_READ_MODE'),
    fileConfig.memoryV4ReadMode,
  ),
  embeddingApiKey: environmentValue('CONTINUUM_MEMORY_EMBEDDING_API_KEY', 'DESKPET_EMBEDDING_API_KEY') || fileConfig.embeddingApiKey || process.env.CONTINUUM_MEMORY_API_KEY || process.env.OPENAI_API_KEY || fileConfig.apiKey || '',
  embeddingBaseURL: environmentValue('CONTINUUM_MEMORY_EMBEDDING_BASE_URL', 'DESKPET_EMBEDDING_BASE_URL') || fileConfig.embeddingBaseURL || process.env.CONTINUUM_MEMORY_BASE_URL || process.env.OPENAI_BASE_URL || fileConfig.baseURL || undefined,
  embeddingModel: environmentValue('CONTINUUM_MEMORY_EMBEDDING_MODEL', 'DESKPET_EMBEDDING_MODEL') || fileConfig.embeddingModel || LOCAL_HASH_EMBEDDING_MODEL,
  uiePythonPath: process.env.CONTINUUM_MEMORY_UIE_PYTHON || fileConfig.uiePythonPath
    || discoveredUie?.pythonPath || 'D:\\Models\\UIE-mini\\.venv-paddle\\Scripts\\python.exe',
  uieModelHome: process.env.CONTINUUM_MEMORY_UIE_MODEL_HOME || fileConfig.uieModelHome || 'D:\\Models\\UIE-mini',
  uieModelPath: process.env.CONTINUUM_MEMORY_UIE_MODEL_PATH || fileConfig.uieModelPath
    || (process.env.CONTINUUM_MEMORY_UIE_MODEL_HOME || fileConfig.uieModelHome ? undefined : discoveredUie?.modelPath),
  nliPythonPath: process.env.CONTINUUM_MEMORY_NLI_PYTHON || fileConfig.nliPythonPath
    || discoveredNli?.pythonPath || '',
  nliModelPath: process.env.CONTINUUM_MEMORY_NLI_MODEL_PATH || fileConfig.nliModelPath
    || discoveredNli?.modelPath || '',
  nliDependenciesPath: process.env.CONTINUUM_MEMORY_NLI_DEPENDENCIES || fileConfig.nliDependenciesPath
    || discoveredNli?.dependenciesPath || '',
}

// ── Persistence ─────────────────────────────────────────
// Packaged builds are portable by default: chat history, encrypted memories,
// models and settings stay next to Continuum Memory.exe instead of AppData on C:.
// Existing installations keep using DeskPetData so the product rename never hides memory.
const executableDirectory = dirname(process.execPath)
const currentPortableDataDir = join(executableDirectory, 'ContinuumMemoryData')
const legacyPortableDataDir = join(executableDirectory, 'DeskPetData')
const portableDataDir = existsSync(currentPortableDataDir) || !existsSync(legacyPortableDataDir)
  ? currentPortableDataDir
  : legacyPortableDataDir
const currentDevelopmentDataDir = app.getPath('userData')
const legacyDevelopmentDataDir = join(app.getPath('appData'), '@deskpet', 'electron')
const developmentDataDir = existsSync(currentDevelopmentDataDir) || !existsSync(legacyDevelopmentDataDir)
  ? ''
  : legacyDevelopmentDataDir
const requestedUserDataDir = environmentValue('CONTINUUM_MEMORY_USER_DATA_DIR', 'DESKPET_USER_DATA_DIR')?.trim()
  || (app.isPackaged ? portableDataDir : developmentDataDir)
if (requestedUserDataDir) {
  mkdirSync(requestedUserDataDir, { recursive: true })
  app.setPath('userData', requestedUserDataDir)
}
const userDataDir = app.getPath('userData')
writeBootLog(`userData: ${userDataDir}`)
const persist = createPersistence(userDataDir)
const settingsMgr = createSettingsManager(persist)

// ── LLM & Tools ────────────────────────────────────────

interface ApiConfig {
  apiKey: string
  baseURL: string
  model: string
}

interface StoredApiConfig {
  encryptedApiKey?: string
  apiKey?: string
  baseURL?: string
  model?: string
}

let apiConfig: ApiConfig = {
  apiKey: config.apiKey,
  baseURL: config.baseURL || 'https://api.openai.com/v1',
  model: config.model,
}

function loadApiConfig(): ApiConfig {
  const stored = persist.loadJson<StoredApiConfig>('api-config', {})
  let apiKey = stored.apiKey || apiConfig.apiKey

  if (stored.encryptedApiKey && safeStorage.isEncryptionAvailable()) {
    try {
      apiKey = safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64'))
    }
    catch (error) {
      writeBootLog(`failed to decrypt API key: ${String(error)}`)
    }
  }

  return {
    apiKey,
    baseURL: stored.baseURL?.trim() || apiConfig.baseURL,
    model: stored.model?.trim() || apiConfig.model,
  }
}

function saveApiConfig() {
  const stored: StoredApiConfig = {
    baseURL: apiConfig.baseURL,
    model: apiConfig.model,
  }
  if (safeStorage.isEncryptionAvailable())
    stored.encryptedApiKey = safeStorage.encryptString(apiConfig.apiKey).toString('base64')
  else
    stored.apiKey = apiConfig.apiKey
  persist.saveJson('api-config', stored)
}

// ── Encrypted session store ─────────────────────────────
const sessionStore = createSessionManager(200)
const sessionsCache: Record<string, ReturnType<typeof sessionStore.getSessionMessages>> = { default: sessionStore.getSessionMessages('default') }
const sessionStoragePath = join(userDataDir, 'sessions.enc')
const sessionKeyPath = join(userDataDir, 'session-key.json')
const legacySessionStoragePath = join(userDataDir, 'sessions.json')
let sessionPersistence: ReturnType<typeof createEncryptedFilePersistence> | undefined

function initializeSessions(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    writeBootLog('session persistence disabled because system encryption is unavailable')
    return
  }
  try {
    sessionPersistence = createEncryptedFilePersistence({
      encryptedPath: sessionStoragePath,
      keyPath: sessionKeyPath,
      legacyPath: legacySessionStoragePath,
      protectKey: key => safeStorage.encryptString(key.toString('base64')),
      unprotectKey: protectedKey => Buffer.from(safeStorage.decryptString(protectedKey), 'base64'),
    })
    const payload = sessionPersistence.load()
    const persistedSessions = payload ? JSON.parse(payload) as Record<string, any[]> : {}
    if (!persistedSessions || typeof persistedSessions !== 'object' || Array.isArray(persistedSessions))
      throw new Error('Encrypted session payload is not an object')
    for (const [sessionId, messages] of Object.entries(persistedSessions)) {
      if (!Array.isArray(messages))
        throw new Error(`Encrypted session ${sessionId} is not an array`)
      sessionStore.ensureSession(sessionId)
      sessionsCache[sessionId] = sessionStore.getSessionMessages(sessionId)
      for (const msg of messages)
        sessionStore.appendSessionMessage(sessionId, msg)
    }
    if (!payload)
      sessionPersistence.save('{}')
    writeBootLog(`encrypted sessions initialized${sessionPersistence.wasLegacyMigrated() ? ' (legacy migrated)' : ''}`)
  }
  catch (error) {
    sessionPersistence = undefined
    writeBootLog(`session persistence disabled after initialization error: ${errorMessage(error)}`)
  }
}

function saveSessions() {
  if (!sessionPersistence)
    return
  for (const id of Object.keys(sessionsCache)) sessionsCache[id] = sessionStore.getSessionMessages(id)
  sessionPersistence.save(JSON.stringify(sessionsCache))
}

const settings = settingsMgr.get()
let agentName = settings.agentName || 'Continuum Memory'

function buildPersona(name: string): string {
  return [
    `Your name is ${name}. You are a friendly and helpful AI companion.`,
    `Always refer to yourself as "${name}" when introducing yourself or referring to yourself.`,
    `If someone asks your name, tell them it is ${name}.`,
    `Respond warmly and naturally, as ${name} would.`,
  ].join(' ')
}

let currentPersona = settings.agentName ? buildPersona(settings.agentName) : 'You are a helpful AI assistant named Continuum Memory.'


const rootUserDataDir = userDataDir
const rootPersist = persist
let skillService: ReturnType<typeof createDesktopSkillService>
let documentRuntime: DocumentRuntime
type PartitionHandler = (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any
interface ConversationPartition {
  handlers: Map<string, PartitionHandler>
  start(): Promise<void>
  activate(): void
  shutdown(): Promise<void>
  smoke(): Promise<void>
}
let conversationRegistry: ReturnType<typeof createConversationRegistry>
const partitions = new Map<string, Promise<ConversationPartition>>()
let activePartition: ConversationPartition
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

const sharedLocalUie = createLocalUieExtractor({
  pythonPath: config.uiePythonPath,
  modelHome: config.uieModelHome,
  modelPath: config.uieModelPath,
  scriptPath: app.isPackaged
    ? join(process.resourcesPath, 'uie_extract.py')
    : join(app.getAppPath(), '..', '..', 'packages', 'memory', 'resources', 'uie_extract.py'),
})

// Model runtimes contain no memory catalog; request IDs keep concurrent partitions separate.
// A partition reload must not dispose a model being used by another partition.
const sharedNliModels = new Map<string, ReturnType<typeof createLocalErlangshenNli>>()
const graphLocalSelection = createLocalGraphEvidenceSelection(
  process.env.CONTINUUM_GRAPH_RERANKER_DIR ? [process.env.CONTINUUM_GRAPH_RERANKER_DIR]
    : [join(rootUserDataDir, 'models', 'reranker-base'), ...localModelWorkDirectories().map(work => join(dirname(work), 'models', 'reranker-base'))],
  () => writeBootLog('Local graph relevance model unavailable; keeping the conservative cosine gate'),
)
function getSharedNliModel(options: Parameters<typeof createLocalErlangshenNli>[0]) {
  const key = JSON.stringify(options)
  let model = sharedNliModels.get(key)
  if (!model) { model = createLocalErlangshenNli(options); sharedNliModels.set(key, model) }
  return { ...model, close() {} }
}

function createConversationPartition(conversation: DesktopConversation, userDataDir: string): ConversationPartition {
  mkdirSync(userDataDir, { recursive: true })
  const persist = createPersistence(userDataDir)
  const handlers = new Map<string, PartitionHandler>()
  const partitionIpc = { handle: (channel: string, handler: PartitionHandler) => {
    if (handlers.has(channel)) throw new Error(`Duplicate partition handler: ${channel}`)
    handlers.set(channel, handler)
  } }
  const sendPartitionEvent = (channel: string, payload?: unknown) =>
    mainWindow?.webContents.send(channel, payload, { conversationId: conversation.id })
  const documentPersistence = safeStorage.isEncryptionAvailable() ? createEncryptedFilePersistence({
    encryptedPath: join(userDataDir, 'documents.enc'), keyPath: join(userDataDir, 'documents-key.json'),
    protectKey: key => safeStorage.encryptString(key.toString('base64')),
    unprotectKey: key => Buffer.from(safeStorage.decryptString(key), 'base64'),
  }) : { load: () => undefined, save: (_value: string) => {} }
  const documents = createDocumentService({ root: join(userDataDir, 'documents'), runtime: documentRuntime,
    persistence: documentPersistence, onChanged: () => sendPartitionEvent('documents:changed', documents.list()) })
  const tools = createToolRegistry([webSearchTool, fileReadTool, httpFetchTool,
    ...documents.tools(),
    ...skillService.tools(conversation.id, () => sendPartitionEvent('skills:used', skillService.history(conversation.id)))])
// ── Scheme A long-term memory ───────────────────────────
type MemoryExtractionMode = 'rules' | 'smart' | 'uie' | 'open'
type MemoryRemotePolicy = 'normal-only' | 'allow-private' | 'disabled'
const memoryV4InternalReviewEnvironmentOverride
  = typeof memoryV4InternalReviewEnvironment === 'string'
    ? config.memoryV4InternalReviewEnabled
    : undefined

interface MemorySettings {
  extractionMode: MemoryExtractionMode
  uieSupplementEnabled: boolean
  /** Run local UIE graph capture alongside the stable rules memory extractor. */
  graphExtractionEnabled: boolean
  openSourceRecallEnabled: boolean
  semanticEnabled: boolean
  imageMemoryEnabled: boolean
  remotePolicy: MemoryRemotePolicy
  /** Only non-authoritative stages are user-selectable before the 1% gate. */
  v4RolloutStage: MemoryV4RolloutStageSetting
}

const defaultMemorySettings: MemorySettings = {
  extractionMode: 'rules',
  uieSupplementEnabled: true,
  graphExtractionEnabled: true,
  openSourceRecallEnabled: false,
  semanticEnabled: false,
  imageMemoryEnabled: true,
  remotePolicy: 'normal-only',
  v4RolloutStage: config.memoryV4InternalReviewEnabled ? 'internal' : 'shadow',
}

function normalizeMemorySettings(value: Partial<MemorySettings> | undefined): MemorySettings {
  return {
    extractionMode: value?.extractionMode === 'smart' || value?.extractionMode === 'uie' || value?.extractionMode === 'open' ? value.extractionMode : 'rules',
    uieSupplementEnabled: value?.uieSupplementEnabled !== false,
    graphExtractionEnabled: value?.graphExtractionEnabled !== false,
    openSourceRecallEnabled: value?.openSourceRecallEnabled === true,
    semanticEnabled: value?.semanticEnabled === true,
    imageMemoryEnabled: value?.imageMemoryEnabled !== false,
    remotePolicy: value?.remotePolicy === 'allow-private' || value?.remotePolicy === 'disabled'
      ? value.remotePolicy
      : 'normal-only',
    v4RolloutStage: normalizeMemoryV4RolloutStage(value?.v4RolloutStage, {
      defaultStage: defaultMemorySettings.v4RolloutStage,
      ...(memoryV4InternalReviewEnvironmentOverride === undefined
        ? {}
        : { environmentOverride: memoryV4InternalReviewEnvironmentOverride ? 'internal' : 'shadow' }),
    }),
  }
}

let memorySettings = normalizeMemorySettings(persist.loadJson<Partial<MemorySettings>>('memory-settings', rootPersist.loadJson<Partial<MemorySettings>>('memory-settings', defaultMemorySettings)))
let memory: ReturnType<typeof createMemoryWriter> | undefined
let memoryPersistence: EncryptedMemoryPersistence | undefined
let memoryEmbeddingIndex: MemoryEmbeddingIndex | undefined
let memoryV4EmbeddingIndex: MemoryEmbeddingIndex | undefined
// Separate in-memory derived cache: fact-index reconciliation must not erase Entity vectors.
let graphEntityEmbeddingIndex = createMemoryEmbeddingIndex()
let memoryV4SemanticBackgroundIndex: MemoryV4SemanticBackgroundIndex | undefined
let memoryInitializationError = ''
let memoryLegacyMigrated = false
let memoryV4Shadow: V4ShadowWriter | undefined
let graphL1Persistence: ReturnType<typeof createEncryptedGraphL1Persistence> | undefined
const graphMemoryEnabled = process.env.CONTINUUM_GRAPH_MEMORY === '1'
// Conservative byte-BPE token upper bound; final escaped graph prompt is checked again by core.
const countGraphTokens = (text: string) => Buffer.byteLength(text, 'utf8')
let memoryV4Repository: MemoryV4Repository | undefined
let memoryV4Lifecycle: MemoryV4LifecycleService | undefined
let memoryCandidateReview: MemoryCandidateReviewService | undefined
let memoryV4Persistence: JournaledV4Persistence | undefined
let memoryV4ConsolidationRunner: IdleConsolidationRunner | undefined
let memoryV4ShadowWorkerClient: MemoryV4ShadowWorkerClient | undefined
let memoryV4ReadController: MemoryV4ReadController | undefined
let memoryV4ShadowComparator: V3V4ShadowComparator = createV3V4ShadowComparator()
interface MemoryV4ShadowComparisonTask {
  generation: number
  query: string
  scope: { ownerId: string; agentId?: string; sessionId?: string }
  v3RetrievedIds: readonly string[]
  v3InjectedIds: readonly string[]
  internalReviewRequestId?: string
}
let memoryV4ShadowEvaluationPersistence: EncryptedMemoryPersistence | undefined
let memoryV4ShadowEvaluationStore: MemoryV4ShadowEvaluationStore | undefined
let memoryV4InternalFeedbackPersistence: EncryptedMemoryPersistence | undefined
let memoryV4InternalFeedbackStore: MemoryV4InternalFeedbackStore | undefined
let graphExtractionStore: GraphExtractionResultStore | undefined
let graphExtractionError = ''
let graphNormalizationStore: GraphNormalizationStore | undefined
let graphL1Store: GraphL1Store | undefined
let graphCaptureRepository: CaptureRepository | undefined
let graphL1Writer: GraphL1Writer | undefined
let graphBasicRelations: BasicGraphRelationRegistry | undefined
let graphSemanticWorkflow: GraphSemanticWorkflow | undefined

function currentGraphPredicateRegistry() {
  return graphBasicRelations ?? createGraphPredicateRegistry()
}
let graphSourceUpgradePromise: Promise<void> = Promise.resolve()
let graphSemanticRepository: GraphSemanticRepository | undefined
let graphL1ProjectionRepository: GraphL1ProjectionRepository | undefined
let graphRelationTaskQueue: GraphRelationTaskQueue | undefined
let graphRelationRepository: GraphRelationRepository | undefined
let graphL2SyncChain: Promise<void> = Promise.resolve()
let graphL2Generation = 0
let graphNliJudge: ReturnType<typeof createLocalErlangshenNli> | undefined
let graphNliDraining = false
let graphNliRetryTimer: ReturnType<typeof setTimeout> | undefined
function invalidateGraphL1Projection(): void {
  try { graphL1ProjectionRepository?.invalidate() }
  catch (error) { writeBootLog(`Graph L1 view invalidation was not persisted: ${errorMessage(error)}`) }
  const repository = graphRelationRepository
  const current = repository?.snapshot()
  if (repository && current?.manifest.state === 'ready') {
    const nextManifestId = `l2-stale:${createHash('sha256').update(`${current.manifest.manifestId}:${Date.now()}`).digest('hex')}`
    void repository.invalidate({ operationId: nextManifestId, scope: current.manifest.scope,
      expectedManifestId: current.manifest.manifestId, nextManifestId, reason: 'core-changed' })
      .then(result => { if (!result.ok) writeBootLog(`Graph L2 invalidation deferred: ${result.error.message}`) })
      .catch(error => writeBootLog(`Graph L2 invalidation failed: ${errorMessage(error)}`))
  }
}
function purgeGraphL2ForMessageIds(messageIds: readonly string[]): void {
  const repository = graphRelationRepository
  const episodes = memoryV4Repository?.snapshot().episodes
  if (!repository || !episodes || messageIds.length === 0) return
  const ids = new Set(episodes.filter(episode => episode.sourceMessageId
    && messageIds.includes(episode.sourceMessageId)).map(episode => episode.id))
  if (ids.size === 0) return
  const current = repository.snapshot()
  const refs = [...current.candidates.flatMap(candidate => candidate.sourceHints),
    ...current.relations.flatMap(relation => [...relation.provenance.sources,
      ...relation.evidence.map(item => item.source)]),
    ...current.observations.flatMap(observation => observation.premise.kind === 'source'
      ? [observation.premise.ref] : [])]
    .filter(source => ids.has(source.episodeId))
  if (refs.length === 0) return
  const sourceVersions = [...new Map(refs.map(ref => [`${ref.episodeId}\0${ref.contentHash}`, ref])).values()]
  const nextManifestId = `l2-source-purge:${createHash('sha256').update(JSON.stringify([
    current.manifest.manifestId, sourceVersions])).digest('hex')}`
  void repository.purge({ operationId: nextManifestId, scope: current.manifest.scope,
    expectedManifestId: current.manifest.manifestId, nextManifestId,
    sourceVersions, claimVersions: [] })
    .then(result => { if (!result.ok) writeBootLog(`Graph L2 source purge deferred: ${result.error.message}`) })
    .catch(error => writeBootLog(`Graph L2 source purge failed: ${errorMessage(error)}`))
}
function syncGraphSemantic(): void {
  reconcileGraphPublicationStatus()
  if (!graphSemanticRepository || !graphL1Store || !memoryV4Repository) return
  void graphSemanticRepository.syncFromClaims(graphL1Store, memoryV4Repository,
    currentGraphPredicateRegistry(), localMemoryScope).then(result => {
    if (!result.ok) writeBootLog(`Graph semantic sync deferred: ${result.error.message}`)
    else {
      graphL1ProjectionRepository?.sync()
      syncGraphRelationTasks()
    }
  }).catch(error => writeBootLog(`Graph semantic sync deferred: ${errorMessage(error)}`))
}
function syncGraphRelationTasks(): void {
  const view = graphL1ProjectionRepository?.snapshot()
  const bundle = view?.semanticBundle
  if (!view || !bundle || !graphRelationTaskQueue || !memoryV4Repository) return
  const episodes = new Map(memoryV4Repository.snapshot().episodes.map(episode => [episode.id, episode]))
  const l2 = graphRelationRepository?.snapshot()
  graphRelationTaskQueue.sync(bundle.claims, bundle.predicates, localMemoryScope,
    claim => graphClaimEvidenceText(claim, episodes),
    l2?.manifest.state === 'ready' && l2.manifest.coreManifestId === view.manifest.manifestId
      ? l2.relations : [])
  void queueGraphL2Sync().catch(error => writeBootLog(`Graph L2 sync deferred: ${errorMessage(error)}`))
  scheduleGraphNliDrain()
}
function queueGraphL2Sync(): Promise<void> {
  const generation = graphL2Generation
  return queueGraphL2Work(() => syncGraphL2Once(generation))
}
function queueGraphL2Work<T>(work: () => Promise<T>): Promise<T> {
  const next = graphL2SyncChain.catch(() => {}).then(work)
  graphL2SyncChain = next.then(() => {}, () => {})
  return next
}
async function syncGraphL2Once(generation: number): Promise<void> {
  if (generation !== graphL2Generation) return
  const core = graphL1ProjectionRepository?.snapshot()
  if (!core || !graphRelationTaskQueue || !memoryV4Repository) return
  if (!graphRelationRepository) {
    const initialCore = core
    graphRelationRepository = createGraphRelationRepository({
      coreSnapshot: () => graphL1ProjectionRepository?.snapshot()
        ?? { ...initialCore, manifest: { ...initialCore.manifest, state: 'stale' } },
      persistence: createEncryptedGraphRelationPersistence({
        encryptedPath: graphRelationStoragePath, keyPath: graphRelationKeyPath,
        protectKey: key => safeStorage.encryptString(key.toString('base64')),
        unprotectKey: protectedKey => Buffer.from(safeStorage.decryptString(protectedKey), 'base64'),
      }),
      verifySources: async (refs, scope, relations) => {
        const episodes = new Map(memoryV4Repository?.snapshot().episodes.map(item => [item.id, item]))
        for (const ref of refs) {
          const episode = episodes.get(ref.episodeId)
          if (!episode || episode.contentState !== 'available' || episode.deletedAt !== undefined
            || !episode.content || episode.contentHash !== ref.contentHash
            || createHash('sha256').update(episode.content, 'utf8').digest('hex') !== ref.contentHash
            || episode.scope.ownerId !== scope.ownerId || episode.scope.agentId !== scope.agentId
            || (scope.sessionId !== undefined && episode.scope.sessionId !== scope.sessionId)
            || (ref.locator.kind === 'text-span' && (ref.locator.start < 0
              || ref.locator.end > episode.content.length || ref.locator.start >= ref.locator.end)))
            return { ok: false, error: { code: 'source-unavailable', message: 'L2 source is no longer exact and available' } }
          for (const relation of relations) {
            if (!relation.provenance.sources.some(item => item.episodeId === ref.episodeId
              && item.contentHash === ref.contentHash)) continue
            if (['normal', 'private', 'secret'].indexOf(relation.sensitivity)
                < ['normal', 'private', 'secret'].indexOf(episode.sensitivity)
              || ['allow-remote', 'ask', 'local-only'].indexOf(relation.sharePolicy)
                < ['allow-remote', 'ask', 'local-only'].indexOf(episode.sharePolicy))
              return { ok: false, error: { code: 'source-unavailable', message: 'L2 relation weakens source policy' } }
          }
        }
        return { ok: true, value: undefined }
      },
    })
  }
  const repository = graphRelationRepository
  const rebound = await rebaseGraphRelations({ repository, core })
  if (!rebound.ok) throw new Error(rebound.error.message)
  if (generation !== graphL2Generation) return
  const episodes = new Map(memoryV4Repository.snapshot().episodes.map(episode => [episode.id, episode]))
  const staged = await stageGraphRelationTasks({ repository, core,
    tasks: graphRelationTaskQueue.snapshot(), evidenceText: claim => graphClaimEvidenceText(claim, episodes) })
  if (!staged.ok) throw new Error(staged.error.message)
}
function graphClaimEvidenceText(claim: Parameters<typeof renderSourceStatementComparison>[0] & {
  provenance: NonNullable<Parameters<typeof renderSourceStatementComparison>[0]['provenance']> },
  episodes = new Map(memoryV4Repository?.snapshot().episodes.map(episode => [episode.id, episode]))) {
  const text = claim.provenance.sources.map((source, i) => {
    const original = episodes.get(source.episodeId)?.content ?? '';
    const value = source.locator.kind === 'text-span' ? original.slice(source.locator.start, source.locator.end) : original;
    return claim.provenance.sources.length > 1 ? '来源 ' + (i + 1) + '：' + value : value;
  }).join('\n');
  return renderSourceStatementComparison(claim, graphSemanticRepository?.snapshot()?.entities ?? [], text);
}

function scheduleGraphNliDrain(): void {
  if (graphNliRetryTimer) clearTimeout(graphNliRetryTimer)
  graphNliRetryTimer = undefined
  if (!graphNliJudge?.isReady() || !graphRelationTaskQueue || graphNliDraining) return
  void drainGraphNli().catch(error => writeBootLog(`Graph NLI drain failed: ${errorMessage(error)}`))
}
async function drainGraphNli(): Promise<void> {
  if (graphNliDraining || !graphNliJudge || !graphRelationTaskQueue) return
  graphNliDraining = true
  const queue = graphRelationTaskQueue, judge = graphNliJudge
  const generation = graphL2Generation
  const isCurrent = () => generation === graphL2Generation && queue === graphRelationTaskQueue
    && judge === graphNliJudge
  try {
    await runBackgroundTaskBatch(queue.ready(), isCurrent, async task => {
      const claims = graphL1ProjectionRepository?.snapshot()?.semanticBundle.claims ?? []
      const premise = claims.find(claim => claim.ref.id === task.claims[0].id
        && claim.ref.version === task.claims[0].version)
      const hypothesis = claims.find(claim => claim.ref.id === task.claims[1].id
        && claim.ref.version === task.claims[1].version)
      if (!premise || !hypothesis) {
        queue.fail(task.key, 'Current L1 Claim version is unavailable', Date.now() + 5_000)
        syncGraphRelationTasks()
        return false
      }
      const premiseText = graphClaimEvidenceText(premise)
      const hypothesisText = graphClaimEvidenceText(hypothesis)
      try {
        if (!premiseText.trim() || !hypothesisText.trim()) throw new Error('Graph Claim evidence is unavailable')
        const result = await judge.judge({ premise: { kind: 'claim', ref: premise.ref, text: premiseText },
          hypothesisText })
        if (!isCurrent()) return false
        if (!result.ok) throw new Error(result.error.message)
        if (result.value.modelId !== task.modelId || result.value.modelRevision !== task.modelRevision
          || result.value.preprocessingVersion !== task.preprocessingVersion)
          throw new Error('Graph NLI task and response versions differ')
        const scores = result.value.scores
        const label = (Object.keys(scores) as Array<keyof typeof scores>)
          .reduce((best, next) => scores[next] > scores[best] ? next : best)
        queue.complete(task.key, { label, scores, truncated: result.value.truncated,
          premiseHash: createHash('sha256').update(premiseText).digest('hex'),
          hypothesisHash: createHash('sha256').update(hypothesisText).digest('hex'), evaluatedAt: Date.now() })
        void queueGraphL2Sync().catch(error => writeBootLog(`Graph L2 staging deferred: ${errorMessage(error)}`))
      }
      catch (error) {
        if (!isCurrent()) return false
        const delay = Math.min(300_000, 5_000 * 2 ** Math.min(task.attempts ?? 0, 6))
        queue.fail(task.key, errorMessage(error), Date.now() + delay)
        writeBootLog(`Graph NLI task deferred: ${errorMessage(error)}`)
        return false
      }
      return true
    })
  }
  finally {
    graphNliDraining = false
    if (graphRelationTaskQueue?.ready().length) {
      graphNliRetryTimer = setTimeout(scheduleGraphNliDrain, 0)
    }
    else {
      const next = graphRelationTaskQueue?.nextRetryAt()
      if (next !== undefined) graphNliRetryTimer = setTimeout(scheduleGraphNliDrain, Math.max(100, next - Date.now()))
    }
  }
}
let memoryV4ShadowTaskQueue: MemoryV4ShadowTaskQueue<MemoryV4ShadowComparisonTask> | undefined
let memoryV4ShadowGeneration = 0
let memoryV4ShadowEvaluationError = ''
let memoryV4InternalFeedbackError = ''
const memoryV4InternalReview = createMemoryV4InternalReviewController({
  enabled: false,
  timeoutMs: 1_500,
})

function memoryV4InternalFeedbackCalibrationStatus() {
  if (!memoryV4InternalFeedbackStore)
    return undefined
  try {
    const dataset = freezeMemoryV4InternalFeedbackDataset(
      memoryV4InternalFeedbackStore.calibrationReviews(),
    )
    const gate = evaluateMemoryV4FeedbackCalibrationGate(dataset)
    return {
      version: dataset.version,
      datasetVersion: dataset.datasetVersion,
      datasetFingerprint: dataset.datasetFingerprint,
      calibrationVersion: dataset.calibrationVersion,
      calibrationStats: dataset.calibrationStats,
      validationStats: dataset.validationStats,
      rankingValidation: dataset.rankingValidation,
      audit: dataset.audit,
      gate,
      onlineInfluence: false,
    }
  }
  catch (error) {
    return {
      error: errorMessage(error),
      onlineInfluence: false,
    }
  }
}
let memoryStore: VectorStore | undefined
let memorySemanticActive = false
let memoryV4SemanticError = ''
let memoryV4Error = ''
let memoryV4Reconciliation = { changed: false, sourceCount: 0, mirroredCount: 0, deletedCount: 0 }
let memoryV4Audit: ReturnType<typeof auditV3V4Consistency> | undefined
// `deskpet` is a stable persisted scope identifier retained for data compatibility.
const localMemoryScope = { ownerId: 'local-user', agentId: 'deskpet' }
/** System idle seconds before offline memory consolidation may run. */
const MEMORY_CONSOLIDATION_IDLE_SECONDS = 120
const memoryStoragePath = join(userDataDir, 'memories.enc')
const memoryKeyPath = join(userDataDir, 'memory-key.json')
const memoryEmbeddingStoragePath = join(userDataDir, 'memory-embeddings.enc')
const memoryEmbeddingKeyPath = join(userDataDir, 'memory-embedding-key.json')
const graphExtractionStoragePath = join(userDataDir, 'graph-extractions.enc')
const graphExtractionKeyPath = join(userDataDir, 'graph-extractions-key.json')
const graphNormalizationStoragePath = join(userDataDir, 'graph-normalization.enc')
const graphNormalizationKeyPath = join(userDataDir, 'graph-normalization-key.json')
const graphL1StoragePath = join(userDataDir, 'graph-l1.enc')
const graphL1KeyPath = join(userDataDir, 'graph-l1-key.json')
const graphSemanticStoragePath = join(userDataDir, 'graph-semantic.enc')
const graphSemanticKeyPath = join(userDataDir, 'graph-semantic-key.json')
const graphL1ProjectionStoragePath = join(userDataDir, 'graph-l1-projection.enc')
const graphL1ProjectionKeyPath = join(userDataDir, 'graph-l1-projection-key.json')
const graphRelationStoragePath = join(userDataDir, 'graph-relations.enc')
const graphRelationKeyPath = join(userDataDir, 'graph-relations-key.json')
const legacyMemoryStoragePath = join(userDataDir, 'memories.json')
const memoryV4StoragePath = join(userDataDir, 'memory-v4.enc')
const memoryV4BackupPath = join(userDataDir, 'memory-v4.enc.backup')
const memoryV4JournalPath = join(userDataDir, 'memory-v4.enc.journal')
const memoryV4KeyPath = join(userDataDir, 'memory-v4-key.json')
const memoryV4ShadowEvaluationPath = join(userDataDir, 'memory-v4-shadow-eval.enc')
const memoryV4ShadowEvaluationKeyPath = join(userDataDir, 'memory-v4-shadow-eval-key.json')
const memoryV4InternalFeedbackPath = join(userDataDir, 'memory-v4-internal-feedback.enc')
const memoryV4InternalFeedbackKeyPath = join(userDataDir, 'memory-v4-internal-feedback-key.json')
const memoryV4EmbeddingStoragePath = join(userDataDir, 'memory-v4-embeddings.enc')
const memoryV4EmbeddingKeyPath = join(userDataDir, 'memory-v4-embedding-key.json')
const memoryV4RuntimeReportPath = join(userDataDir, 'memory-v4-runtime-report.json')
const memoryV4RuntimeObservability = createMemoryV4RuntimeObservability({ persistence: persist })
let semanticModelProgress: SemanticModelProgress = { status: 'idle' }
let semanticPreparationPromise: Promise<void> | undefined
let imageMemoryProgress: { status: string; progress?: number } = { status: 'idle' }
const purgeConfirmation = createMemoryPurgeConfirmationGate()
const semanticMemory = createSemanticMemoryService(join(rootUserDataDir, 'models', 'memory'), (progress) => {
  updateSemanticModelProgress(progress)
})
// Query-only cache; never puts private contextual vectors in an external service or disk.
const openContextVectorCache = new Map<string, number[]>()
async function embedOpenContext(text: string): Promise<number[]> {
  if (!memorySettings.semanticEnabled || !semanticMemory.isVerified()) throw new Error('Local semantic model unavailable')
  const key = createHash('sha256').update(`${SEMANTIC_MEMORY_FINGERPRINT}\0${text}`).digest('hex')
  const cached = openContextVectorCache.get(key)
  if (cached) return [...cached]
  const vector = await semanticMemory.embed(text)
  if (openContextVectorCache.size >= 256) openContextVectorCache.delete(openContextVectorCache.keys().next().value!)
  openContextVectorCache.set(key, [...vector])
  return vector
}
const imageMemory = createImageMemoryService(join(rootUserDataDir, 'models', 'ocr'), (progress) => {
  imageMemoryProgress = progress
  sendPartitionEvent('memory:ocr-progress', progress)
})
const localUie = { ...sharedLocalUie, dispose() {} }

function updateSemanticModelProgress(progress: SemanticModelProgress): void {
  semanticModelProgress = progress
  sendPartitionEvent('memory:model-progress', progress)
}

function prepareSemanticMemoryIndex(): Promise<void> {
  if (semanticPreparationPromise)
    return semanticPreparationPromise
  semanticPreparationPromise = (async () => {
    if (!memoryStore || !memoryEmbeddingIndex)
      throw new Error('长期记忆索引尚未初始化。')
    const initial = memoryStore.embeddingStatus(SEMANTIC_MEMORY_FINGERPRINT, localMemoryScope)
    updateSemanticModelProgress({
      status: 'indexing',
      progress: initial.total === 0 ? 100 : initial.ready / initial.total * 100,
      ...initial,
    })
    const result = await memoryStore.prepareEmbeddings(
      SEMANTIC_MEMORY_FINGERPRINT,
      semanticMemory.embed,
      localMemoryScope,
      {
        batchSize: 8,
        onProgress: progress => updateSemanticModelProgress({
          status: 'indexing',
          progress: progress.total === 0 ? 100 : progress.ready / progress.total * 100,
          total: progress.total,
          ready: progress.ready,
          pending: progress.pending,
        }),
      },
    )
    if (result.pending > 0)
      throw new Error(`仍有 ${result.pending} 条记忆未完成语义索引，请重试。`)
    updateSemanticModelProgress({ status: 'ready', progress: 100, ...result })
  })().catch((error) => {
    updateSemanticModelProgress({ status: 'error', error: errorMessage(error) })
    throw error
  }).finally(() => {
    semanticPreparationPromise = undefined
  })
  return semanticPreparationPromise
}

function saveMemorySettings(): void {
  persist.saveJson('memory-settings', memorySettings)
}

function mergeMemoryCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
  const unique = new Map<string, MemoryCandidate>()
  for (const candidate of candidates) {
    const key = candidate.content.toLocaleLowerCase()
    if (!unique.has(key))
      unique.set(key, candidate)
  }
  return [...unique.values()].slice(0, 8)
}

function retirePolicySourceClaims(sourceId: string, keepRunId: string) {
  const tasks = graphL1Store?.tasks().filter(t => t.run.sourceId === sourceId && t.run.id !== keepRunId
    && t.state === 'published' && t.review.reviewer === 'policy') ?? [];
  for (const task of tasks) if (task.factRef && memoryV4Lifecycle) memoryV4Lifecycle.deleteFact(task.factRef.id, localMemoryScope, 'suppress',
    { reason: '来源经新证据或新提取策略重新处理', idempotencyKey: 'source-reassessment:' + keepRunId + ':' + task.id });
  graphL1Store?.retireClaims(tasks.map(t => t.id));
  if (tasks.length) invalidateGraphL1Projection();
}

function reconcileGraphPublicationStatus(): void {
  const snapshot = memoryV4Repository?.snapshot()
  const active = new Set((graphL1Store?.claims() ?? []).filter(claim => snapshot?.facts.some(fact =>
    fact.id === claim.fact.id && fact.status === 'active' && fact.invalidatedAt === undefined)
    && snapshot.factVersions.some(version => version.factId === claim.fact.id && version.version === claim.fact.version
      && version.transactionClosedAt === undefined)
    && claim.provenance.sources.every(source => snapshot.episodes.some(episode => episode.id === source.episodeId
      && episode.contentState === 'available' && episode.deletedAt === undefined && episode.contentHash === source.contentHash)))
    .map(claim => claim.ref.id))
  graphSemanticWorkflow?.reconcilePublication((graphL1Store?.tasks() ?? [])
    .filter(task => task.state === 'published' && active.has(task.id))
    .map(task => ({ runId: task.run.id, claimId: task.id })))
}

async function saveGraphExtraction(run: GraphExtractionRun, forceSemanticReview = false): Promise<void> {
  if (!graphExtractionStore) throw new Error('Graph extraction persistence is unavailable')
  if (!graphExtractionStore.list().some(item => item.id === run.id)) graphExtractionStore.append(run)
  if (graphSemanticWorkflow && (forceSemanticReview || !graphSemanticWorkflow.isReviewed(run))
    && (forceSemanticReview || run.remoteExtraction || ((memorySettings.extractionMode === 'open' || memorySettings.extractionMode === 'smart')
    && (run.modelId === apiConfig.model || run.modelId === 'uie-base'))) && run.status === 'complete') {
    const assessed = await graphSemanticWorkflow.process(run)
    if (!assessed) { syncGraphSemantic(); sendPartitionEvent('memory:changed'); return }
    run = assessed
  }
  if (run.semanticReview) graphExtractionStore.savePublicationView?.(run)
  if ((forceSemanticReview && run.status === 'complete')
    || (run.supplementalEvidence?.length && (run.factCandidates.length || run.assertionCandidates?.length))) retirePolicySourceClaims(run.sourceId, run.id)
  const registry = currentGraphPredicateRegistry()
  const sourcePrivacy = inferMemoryPrivacy(run.sourceText)
  const rejectedOpen = new Set(graphCaptureRepository ? projectOpenAssertions(graphCaptureRepository.snapshot(),
    graphExtractionStore, localMemoryScope).filter(item => item.review.status === 'rejected'
      && item.extraction.runId === run.id).map(item => item.extraction.candidateId) : [])
  if (sourcePrivacy.sensitivity !== 'secret' && graphBasicRelations) run = graphBasicRelations.prepare({ ...run,
    factCandidates: run.factCandidates.filter(item => !rejectedOpen.has(item.id)),
    assertionCandidates: run.assertionCandidates?.filter(item => !rejectedOpen.has(item.id)),
  })
  if (graphNormalizationStore && run.status !== 'failed') {
    const normalized = normalizeGraphExtraction(run, {
      entities: graphNormalizationStore.entities(),
      aliasDecisions: graphNormalizationStore.aliasDecisions(),
      vectorCandidatesByMentionId: graphEntityVectorCandidates(run, graphNormalizationStore.entities(), localMemoryScope),
      scope: localMemoryScope,
      registry,
    })
    graphNormalizationStore.appendResult(normalized)
    const openCandidateIds = new Set(run.factCandidates.filter(fact => needsOpenFactRepresentation(run, fact, registry)).map(fact => fact.id))
    for (const initialFact of normalized.facts) {
      let fact = initialFact
      if (openCandidateIds.has(fact.sourceFactId)) continue
      const evidence = run.factCandidates.find(item => item.id === fact.sourceFactId)
      if (!evidence) continue
      const sourcePrivacy = inferMemoryPrivacy(run.sourceText)
      const automatic = fact.status !== 'ready' && sourcePrivacy.sensitivity !== 'secret'
        ? autoNormalizeUieGraphFact(run, fact.sourceFactId, {
        entities: graphNormalizationStore.entities(), aliases: graphNormalizationStore.aliasDecisions(),
        scope: localMemoryScope, registry,
      }) : undefined
      if (automatic) fact = automatic.normalized.facts.find(item => item.sourceFactId === fact.sourceFactId) ?? fact
      const privacy = run.modelId === 'uie-base' && sourcePrivacy.sensitivity !== 'secret'
        ? { sensitivity: 'private' as const, sharePolicy: 'local-only' as const } : sourcePrivacy
      const review = assessGraphClaim(run, fact, privacy)
      if (graphL1Writer && review.status === 'approved') {
        const entities = automatic?.entities ?? graphNormalizationStore.entities()
        const task = await graphL1Writer.submit(run, fact, review, entities)
        if (task?.state === 'published' && automatic) {
          graphNormalizationStore.replaceCatalog(entities, graphNormalizationStore.aliasDecisions())
          graphNormalizationStore.appendResult(automatic.normalized)
        }
        if (task && task.state !== 'published') graphExtractionError = task.lastError ?? '图事实发布尚未完成'
      }
      else if (!graphL1Store?.reviews().some(item => item.id === review.id))
        graphL1Store?.recordReview(review)
    }
  }
  syncGraphSemantic()
  reconcileGraphPublicationStatus()
  sendPartitionEvent('memory:changed')
}

function createConfiguredMemoryExtractor(): MemoryExtractor {
  const captureSettings = { ...memorySettings }
  const captureApiConfig = { ...apiConfig }
  const canSendSource = (turn: Parameters<MemoryExtractor>[0]): boolean => {
    if (captureSettings.remotePolicy === 'disabled' || !isSafeMemoryContent(turn.userMessage)) return false
    const blocked = memoryStore?.blockedSourceMessageIds(localMemoryScope)
    if (Array.isArray(turn.metadata?.sourceMessageIds)
      && turn.metadata.sourceMessageIds.some(id => typeof id === 'string' && blocked?.has(id))) return false
    const privacy = inferMemoryPrivacy(turn.userMessage)
    // Enabling an extraction mode never overrides local-only private/secret source policy.
    return privacy.sensitivity === 'normal' && privacy.sharePolicy === 'allow-remote'
  }
  const smartExtractor = createSmartMemoryExtractor({
    getConfig: () => captureApiConfig,
    fallback: extractMemoryCandidates,
    canSendSource,
    saveGraphExtraction: run => shouldPersistGraphExtraction(captureSettings, 'remote') ? saveGraphExtraction(run) : undefined,
  })
  const openExtractor = createOpenGraphExtractor({
    getConfig: () => captureApiConfig,
    fallback: extractMemoryCandidates,
    canSendSource,
    saveGraphExtraction,
  })
  const uieWithRules = createUieRuleFallbackExtractor({
    uie: localUie,
    adaptiveSchema: true,
    rules: extractMemoryCandidates,
    onGraphExtraction: async (_turn, run) => {
      if (shouldPersistGraphExtraction(captureSettings, 'local'))
        await saveGraphExtraction(run)
      if (run.modelId === 'uie-base') graphExtractionError = ''
    },
    onError: error => {
      graphExtractionError = errorMessage(error)
      writeBootLog(`Local UIE-base graph capture failed; rules memory remains active: ${graphExtractionError}`)
    },
  })
  return async (turn) => {
    // Open discovery is persisted before UIE starts: UIE failure cannot gate arbitrary relations.
    let candidates: MemoryCandidate[] = captureSettings.extractionMode === 'open'
      ? await openExtractor(turn)
      : captureSettings.extractionMode === 'smart'
        ? await smartExtractor(turn) : await extractMemoryCandidates(turn)
    if (captureSettings.uieSupplementEnabled || captureSettings.extractionMode === 'uie')
      candidates = mergeMemoryCandidates([...candidates, ...await uieWithRules(turn)])
    if (!captureSettings.imageMemoryEnabled
      || !turn.attachments?.length
      || !isExplicitImageMemoryRequest(turn.userMessage))
      return candidates

    const imageCandidates: MemoryCandidate[] = []
    for (const attachment of turn.attachments) {
      try {
        const candidate = await imageMemory.extractCandidate(attachment)
        if (candidate)
          imageCandidates.push(candidate)
      }
      catch (error) {
        writeBootLog(`image memory OCR failed: ${errorMessage(error)}`)
      }
    }
    return mergeMemoryCandidates([...candidates, ...imageCandidates])
  }
}

function createV4ShadowQueryHasher(): (query: string) => string {
  const slot = 'memory-v4-shadow-eval-hmac-key'
  const stored = persist.loadJson<{ version?: unknown; protectedKey?: unknown }>(slot, {})
  let key: Buffer
  if (stored.version === 1 && typeof stored.protectedKey === 'string') {
    key = Buffer.from(safeStorage.decryptString(Buffer.from(stored.protectedKey, 'base64')), 'base64')
  }
  else {
    key = randomBytes(32)
    persist.saveJson(slot, {
      version: 1,
      protectedKey: safeStorage.encryptString(key.toString('base64')).toString('base64'),
    })
  }
  if (key.length !== 32)
    throw new Error('V4 shadow evaluation HMAC key has an invalid length')
  return query => createHmac('sha256', key).update(query.normalize('NFKC')).digest('hex')
}

/**
 * Reuse the verified, encrypted V3 side-index vectors for their mirrored V4
 * facts. Content-hash lookup prevents a vector from surviving a fact edit, and
 * the Worker validates revision/model/dimension again before indexing it.
 */
function buildV4SemanticIndexSnapshot(snapshot: MemoryV4Snapshot): MemoryV4SemanticIndexSnapshot | undefined {
  if (memoryV4SemanticBackgroundIndex)
    return memoryV4SemanticBackgroundIndex.semanticSnapshot(snapshot)
  const index = memoryEmbeddingIndex
  if (!memorySemanticActive || !index)
    return undefined
  return buildMemoryV4SemanticIndexSnapshot({
    snapshot,
    model: SEMANTIC_MEMORY_FINGERPRINT,
    expectedDimension: SEMANTIC_MEMORY_EXPECTED_DIMENSION,
    factVector: ({ sourceMemoryId, content }) => index.get(sourceMemoryId, SEMANTIC_MEMORY_FINGERPRINT, content),
    // Summary vectors are prepared in the next background-indexing slice. V4
    // keeps hash/BM25 summary navigation until then; learned fact retrieval is
    // already independent and complete for mirrored V3 facts.
  })
}

function initializeMemory(): void {
  memoryV4ShadowGeneration += 1
  memoryV4InternalReview.setEnabled(false)
  try {
    memoryV4Shadow?.flush()
  }
  catch (error) {
    writeBootLog(`Memory V4 shadow flush before reinitialize failed: ${errorMessage(error)}`)
  }
  try {
    memoryV4ShadowEvaluationStore?.flush()
  }
  catch (error) {
    writeBootLog(`Memory V4 shadow evaluation flush before reinitialize failed: ${errorMessage(error)}`)
  }
  try {
    memoryV4InternalFeedbackStore?.flush()
  }
  catch (error) {
    writeBootLog(`Memory V4 Internal feedback flush before reinitialize failed: ${errorMessage(error)}`)
  }
  memory = undefined
  memoryPersistence = undefined
  memoryEmbeddingIndex = undefined
  openContextVectorCache.clear()
  memoryV4EmbeddingIndex = undefined
  graphEntityEmbeddingIndex = createMemoryEmbeddingIndex()
  memoryV4SemanticBackgroundIndex = undefined
  memoryV4Shadow = undefined
  memoryV4Repository = undefined
  memoryV4Lifecycle = undefined
  memoryV4ConsolidationRunner?.stop()
  memoryV4ConsolidationRunner = undefined
  memoryV4ShadowTaskQueue?.stop()
  memoryV4ShadowTaskQueue = undefined
  memoryV4ShadowWorkerClient?.stop()
  memoryV4ShadowWorkerClient = undefined
  memoryV4ReadController = undefined
  memoryV4ShadowComparator = createV3V4ShadowComparator()
  memoryV4ShadowEvaluationPersistence = undefined
  memoryV4ShadowEvaluationStore = undefined
  memoryV4InternalFeedbackPersistence = undefined
  graphExtractionStore = undefined
  graphExtractionError = ''
  graphNormalizationStore = undefined
  graphL1Store = undefined
  graphCaptureRepository = undefined
  graphL1Writer = undefined
  graphBasicRelations = undefined
  graphSemanticWorkflow = undefined
  graphSemanticRepository = undefined
  graphL1ProjectionRepository = undefined
  graphRelationTaskQueue = undefined
  graphRelationRepository = undefined
  graphL2Generation++
  graphNliJudge?.close()
  graphNliJudge = undefined
  if (graphNliRetryTimer) clearTimeout(graphNliRetryTimer)
  graphNliRetryTimer = undefined
  memoryV4InternalFeedbackStore = undefined
  memoryV4ShadowEvaluationError = ''
  memoryV4InternalFeedbackError = ''
  memoryCandidateReview = undefined
  memoryV4Persistence = undefined
  memoryStore = undefined
  memorySemanticActive = false
  memoryV4SemanticError = ''
  purgeConfirmation.clear()
  memoryInitializationError = ''
  memoryLegacyMigrated = false
  memoryV4Error = ''
  memoryV4Reconciliation = { changed: false, sourceCount: 0, mirroredCount: 0, deletedCount: 0 }
  memoryV4Audit = undefined
  if (!config.memoryEnabled)
    return
  try {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('系统安全存储不可用，为避免明文保存，长期记忆未启动。')
    const persistence = createEncryptedFilePersistence({
      encryptedPath: memoryStoragePath,
      keyPath: memoryKeyPath,
      legacyPath: legacyMemoryStoragePath,
      protectKey: key => safeStorage.encryptString(key.toString('base64')),
      unprotectKey: protectedKey => Buffer.from(safeStorage.decryptString(protectedKey), 'base64'),
    })
    memoryPersistence = persistence
    const graphPersistence = createEncryptedFilePersistence({
      encryptedPath: graphExtractionStoragePath,
      keyPath: graphExtractionKeyPath,
      protectKey: key => safeStorage.encryptString(key.toString('base64')),
      unprotectKey: protectedKey => Buffer.from(safeStorage.decryptString(protectedKey), 'base64'),
    })
    graphExtractionStore = createGraphExtractionResultStore(graphPersistence)
    const graphNormalizationPersistence = createEncryptedFilePersistence({
      encryptedPath: graphNormalizationStoragePath,
      keyPath: graphNormalizationKeyPath,
      protectKey: key => safeStorage.encryptString(key.toString('base64')),
      unprotectKey: protectedKey => Buffer.from(safeStorage.decryptString(protectedKey), 'base64'),
    })
    graphNormalizationStore = createGraphNormalizationStore(graphNormalizationPersistence)
    graphBasicRelations = createBasicGraphRelationRegistry(createEncryptedFilePersistence({
      encryptedPath: join(userDataDir, 'graph-basic-relations.enc'),
      keyPath: join(userDataDir, 'graph-basic-relations-key.json'),
      protectKey: key => safeStorage.encryptString(key.toString('base64')),
      unprotectKey: protectedKey => Buffer.from(safeStorage.decryptString(protectedKey), 'base64'),
    }), localMemoryScope)
    const graphClaimPersistence = createEncryptedFilePersistence({
      encryptedPath: graphL1StoragePath,
      keyPath: graphL1KeyPath,
      protectKey: key => safeStorage.encryptString(key.toString('base64')),
      unprotectKey: protectedKey => Buffer.from(safeStorage.decryptString(protectedKey), 'base64'),
    })
    graphL1Store = createGraphL1Store(graphClaimPersistence)
    try {
      const recovered = recoverGraphClaimReviews(graphExtractionStore.list(), graphNormalizationStore,
        graphL1Store, localMemoryScope)
      if (recovered) writeBootLog(`Restored ${recovered} missing graph candidate reviews`)
    }
    catch (error) { writeBootLog(`Graph review recovery failed: ${errorMessage(error)}`) }
    let embeddingIndex: MemoryEmbeddingIndex | undefined
    try {
      const embeddingPersistence = createEncryptedFilePersistence({
        encryptedPath: memoryEmbeddingStoragePath,
        keyPath: memoryEmbeddingKeyPath,
        protectKey: key => safeStorage.encryptString(key.toString('base64')),
        unprotectKey: protectedKey => Buffer.from(safeStorage.decryptString(protectedKey), 'base64'),
      })
      embeddingIndex = createMemoryEmbeddingIndex({ persistence: embeddingPersistence })
    }
    catch (error) {
      writeBootLog(`semantic side index disabled: ${errorMessage(error)}`)
      updateSemanticModelProgress({ status: 'error', error: `派生语义索引不可用：${errorMessage(error)}` })
    }
    memoryEmbeddingIndex = embeddingIndex
    const probeStore = createVectorStore({
      persistence,
      embeddingModel: LOCAL_HASH_EMBEDDING_MODEL,
      ...(embeddingIndex ? { embeddingIndex } : {}),
    })
    const semanticRequested = memorySettings.semanticEnabled
    const requestedSemantic = semanticRequested && semanticMemory.isVerified()
    const preparedSemantic = probeStore.embeddingStatus(SEMANTIC_MEMORY_FINGERPRINT, localMemoryScope)
    const semanticActive = !!embeddingIndex && requestedSemantic && preparedSemantic.pending === 0
    memorySemanticActive = semanticActive
    if (semanticRequested && !semanticActive) {
      memorySettings.semanticEnabled = false
      saveMemorySettings()
      if (semanticMemory.isVerified()) {
        updateSemanticModelProgress({
          status: 'idle',
          integrity: semanticMemory.integrity().state,
          ...preparedSemantic,
        })
        writeBootLog(`semantic activation deferred: ${preparedSemantic.pending}/${preparedSemantic.total} vectors pending`)
      }
      else {
        writeBootLog(`semantic activation disabled: ${semanticMemory.integrity().error ?? semanticMemory.integrity().state}`)
      }
    }
    const store = createVectorStore({
      persistence,
      embeddingModel: semanticActive
        ? SEMANTIC_MEMORY_FINGERPRINT
        : LOCAL_HASH_EMBEDDING_MODEL,
      ...(semanticActive ? { embedder: semanticMemory } : {}),
      ...(embeddingIndex ? { embeddingIndex } : {}),
      foregroundEmbeddingUpgrade: !semanticActive,
      onCommittedChange: commit => memoryV4Shadow?.enqueueCommit(commit),
      onCommitObserverError: error => writeBootLog(`Memory V4 commit enqueue failed: ${errorMessage(error)}`),
    })
    memoryStore = store
    if (semanticActive)
      updateSemanticModelProgress({
        status: 'ready',
        progress: 100,
        integrity: semanticMemory.integrity().state,
        ...preparedSemantic,
      })
    graphCaptureRepository = createCaptureRepository({
      persistence: createEncryptedFilePersistence({
        encryptedPath: join(userDataDir, 'memory-captures.enc'),
        keyPath: join(userDataDir, 'memory-captures.key'),
        protectKey: key => safeStorage.encryptString(key.toString('base64')),
        unprotectKey: protectedKey => Buffer.from(safeStorage.decryptString(protectedKey), 'base64'),
      }),
    })
    memory = createMemoryWriter({
      store,
      captureRepository: graphCaptureRepository,
      onCaptureSourcesChanged: () => syncGraphSemantic(),
      captureProcessorVersion: `capture-v1:${createHmac('sha256', 'capture-profile-v1').update(JSON.stringify({
        mode: memorySettings.extractionMode,
        extractionPipeline: 'open-first-v2:' + GRAPH_SEMANTIC_WORKFLOW_VERSION,
        uieSupplementEnabled: memorySettings.uieSupplementEnabled,
        graphExtractionEnabled: memorySettings.graphExtractionEnabled,
        remotePolicy: memorySettings.remotePolicy,
        imageMemoryEnabled: memorySettings.imageMemoryEnabled,
        uieModelHome: config.uieModelPath ?? config.uieModelHome,
        ...(memorySettings.extractionMode === 'smart' || memorySettings.extractionMode === 'open' ? { model: apiConfig.model, baseURL: apiConfig.baseURL } : {}),
      })).digest('hex')}`,
      extractor: createConfiguredMemoryExtractor(),
      onCaptured: (capture) => {
        memoryV4Shadow?.enqueueCapture(capture)
        memoryV4Shadow?.flush()
      },
      onCaptureObserverError: error => writeBootLog(`Memory V4 capture enqueue failed: ${errorMessage(error)}`),
      onSourcesUnlinked: (commit) => {
        purgeGraphL2ForMessageIds(commit.messageIds)
        const affectedSources = [...new Set([...commit.messageIds, ...[...(graphExtractionStore?.list() ?? []), ...(graphL1Store?.tasks().map(t => t.run) ?? []), ...(graphSemanticWorkflow?.list().map(i => i.run) ?? [])].filter(r =>
          r.supplementalEvidence?.some(e => commit.messageIds.includes(e.sourceId))).map(r => r.sourceId)])];
        graphExtractionStore?.removeSources(affectedSources)
        graphNormalizationStore?.removeSources(affectedSources)
        graphL1Store?.removeSources(affectedSources)
        graphSemanticWorkflow?.removeSources(affectedSources)
        invalidateGraphL1Projection()
        memoryV4Shadow?.enqueueSourceUnlink(commit)
        memoryV4Shadow?.flush()
        syncGraphSemantic()
      },
      onSourceUnlinkObserverError: error => writeBootLog(`Memory V4 source unlink enqueue failed: ${errorMessage(error)}`),
      onRecallFeedback: (report) => {
        const adopted: string[] = []
        const corrected: string[] = []
        const denied: string[] = []
        for (const entry of report.outcomes) {
          if (entry.outcome === 'adopted')
            adopted.push(entry.memoryId)
          else if (entry.outcome === 'corrected')
            corrected.push(entry.memoryId)
          else if (entry.outcome === 'denied')
            denied.push(entry.memoryId)
        }
        memoryV4Shadow?.enqueueRetrievalFeedback({
          query: report.query,
          scope: report.scope,
          ...(adopted.length > 0 ? { adoptedMemoryIds: adopted } : {}),
          ...(corrected.length > 0 ? { correctedMemoryIds: corrected } : {}),
          ...(denied.length > 0 ? { deniedMemoryIds: denied } : {}),
          ...(report.answerModel ? { answerModel: report.answerModel } : {}),
        })
        memoryV4Shadow?.flush()
      },
      onRecallFeedbackObserverError: error => writeBootLog(`Memory V4 retrieval feedback enqueue failed: ${errorMessage(error)}`),
      onBackgroundCaptureError: error => writeBootLog(`Memory background capture failed: ${errorMessage(error)}`),
    })
    memoryLegacyMigrated = persistence.wasLegacyMigrated()
    const initializedWriter = memory
    // Run only after synchronous V4 setup has finished, and never on an obsolete writer.
    queueMicrotask(() => {
      if (memory === initializedWriter) {
        void initializedWriter.resumePendingCaptures().catch(error => {
          writeBootLog(`Memory capture recovery failed: ${errorMessage(error)}`)
        })
      }
    })
    writeBootLog(`long-term memory initialized (${semanticActive ? 'semantic' : 'local-hash'})`)
    if (!config.memoryV4ShadowEnabled) {
      writeBootLog('Memory V4 shadow disabled by kill switch; V3 remains authoritative')
      return
    }
    try {
      const v4Checkpoint = createEncryptedV4Persistence({
        encryptedPath: memoryV4StoragePath,
        keyPath: memoryV4KeyPath,
        backupPath: memoryV4BackupPath,
        protectKey: key => safeStorage.encryptString(key.toString('base64')),
        unprotectKey: protectedKey => Buffer.from(safeStorage.decryptString(protectedKey), 'base64'),
      })
      const v4Persistence = createJournaledV4Persistence({
        checkpoint: v4Checkpoint,
        journalPath: memoryV4JournalPath,
      })
      graphL1Persistence = createEncryptedGraphL1Persistence({
        encryptedPath: join(userDataDir, 'memory-graph-l1.enc'),
        keyPath: join(userDataDir, 'memory-graph-l1.key'),
        protectKey: key => safeStorage.encryptString(key.toString('base64')),
        unprotectKey: protectedKey => Buffer.from(safeStorage.decryptString(protectedKey), 'base64'),
      })
      const l1Persistence = graphL1Persistence
      const v4Repository = createMemoryV4Repository({ persistence: withGraphSourceInvalidation(v4Persistence, () => {
        // Covers lifecycle purge, shadow writes and updates outside the Agent port, even when graph mode is off.
        if (existsSync(l1Persistence.storagePath!)) l1Persistence.save('{}')
      }) })
      memoryV4Repository = v4Repository
      const graphSemanticPersistence = createEncryptedFilePersistence({
        encryptedPath: graphSemanticStoragePath,
        keyPath: graphSemanticKeyPath,
        protectKey: key => safeStorage.encryptString(key.toString('base64')),
        unprotectKey: protectedKey => Buffer.from(safeStorage.decryptString(protectedKey), 'base64'),
      })
      graphSemanticRepository = createGraphSemanticRepository(graphSemanticPersistence, v4Repository, graphCaptureRepository, graphExtractionStore)
      graphL1ProjectionRepository = createGraphL1ProjectionRepository(createEncryptedFilePersistence({
        encryptedPath: graphL1ProjectionStoragePath, keyPath: graphL1ProjectionKeyPath,
        protectKey: key => safeStorage.encryptString(key.toString('base64')),
        unprotectKey: protectedKey => Buffer.from(safeStorage.decryptString(protectedKey), 'base64'),
      }), graphSemanticRepository, v4Repository, graphL1Store!, graphCaptureRepository, graphExtractionStore)
      const nliRevision = config.nliModelPath ? basename(config.nliModelPath) : 'unavailable'
      graphNliJudge = getSharedNliModel({
        pythonPath: config.nliPythonPath,
        modelPath: config.nliModelPath,
        dependenciesPath: config.nliDependenciesPath,
        modelRevision: nliRevision,
        preprocessingVersion: ERLANGSHEN_NLI_PREPROCESSING_VERSION + ':source-statement-v2',
        scriptPath: app.isPackaged
          ? join(process.resourcesPath, 'erlangshen_nli.py')
          : join(app.getAppPath(), 'resources', 'erlangshen_nli.py'),
      })
      if (!graphNliJudge.isReady()) writeBootLog('Local Erlangshen NLI runtime is unavailable; relation tasks remain pending')
      graphRelationTaskQueue = createGraphRelationTaskQueue(createEncryptedFilePersistence({
        encryptedPath: join(userDataDir, 'graph-relation-tasks.enc'),
        keyPath: join(userDataDir, 'graph-relation-tasks-key.json'),
        protectKey: key => safeStorage.encryptString(key.toString('base64')),
        unprotectKey: protectedKey => Buffer.from(safeStorage.decryptString(protectedKey), 'base64'),
      }), { modelId: ERLANGSHEN_NLI_MODEL_ID, modelRevision: nliRevision,
        preprocessingVersion: ERLANGSHEN_NLI_PREPROCESSING_VERSION + ':source-statement-v2' })
      syncGraphSemantic()
      graphL1ProjectionRepository.sync()
      syncGraphRelationTasks()
      const predicateRegistry = currentGraphPredicateRegistry()
      const writerStore = graphL1Store, writerSemantic = graphSemanticRepository, writerProjection = graphL1ProjectionRepository
      const writerIsCurrent = () => graphL1Store === writerStore && graphSemanticRepository === writerSemantic
        && graphL1ProjectionRepository === writerProjection
      graphL1Writer = createGraphL1Writer(v4Repository, graphL1Store!, predicateRegistry, localMemoryScope, {
        isCurrent: writerIsCurrent,
        syncFromClaims: async () => {
          if (!writerIsCurrent()) throw new Error('Graph store changed during publication')
          const result = await writerSemantic!.syncFromClaims(writerStore!, v4Repository,
            predicateRegistry, localMemoryScope)
          if (!writerIsCurrent()) throw new Error('Graph store changed during publication')
          if (!result.ok) throw new Error(result.error.message)
          if (!graphL1ProjectionRepository?.sync()) throw new Error('Stable L1 graph view is not ready')
          syncGraphRelationTasks()
        },
      })
      const workflowRegistry = graphBasicRelations!, workflowCaptures = graphCaptureRepository!, workflowExtractions = graphExtractionStore!;
      graphSemanticWorkflow = createGraphSemanticWorkflow({
        persistence: createEncryptedFilePersistence({ encryptedPath: join(userDataDir, 'graph-semantic-workflow.enc'),
          keyPath: join(userDataDir, 'graph-semantic-workflow-key.json'),
          protectKey: key => safeStorage.encryptString(key.toString('base64')),
          unprotectKey: key => Buffer.from(safeStorage.decryptString(key), 'base64') }),
        registry: workflowRegistry, getConfig: () => ({ ...apiConfig }),
        canUse: run => {
          if (workflowRegistry !== graphBasicRelations || workflowCaptures !== graphCaptureRepository
            || workflowExtractions !== graphExtractionStore || memorySettings.remotePolicy === 'disabled') return false;
          const snapshot = workflowCaptures.snapshot();
          const blocked = memoryStore?.blockedSourceMessageIds(localMemoryScope) ?? new Set<string>();
          const matches = snapshot.sources.filter(source => source.status === 'active'
            && source.scope.ownerId === localMemoryScope.ownerId && source.scope.agentId === localMemoryScope.agentId
            && (source.id === run.sourceId || source.messageIds.includes(run.sourceId))
            && !source.messageIds.some(id => blocked.has(id))
            && (source.turn?.userMessage === run.sourceText || snapshot.tasks.some(task => task.sourceId === source.id
              && source.turn?.userMessage.slice(task.start, task.end) === run.sourceText)));
          return matches.length === 1 && (run.supplementalEvidence ?? []).every(extra => {
            if (blocked.has(extra.sourceId)) return false;
            if (extra.sourceId.startsWith('clarification:')) return graphSemanticWorkflow?.list().some(i =>
              i.reply?.sourceId === extra.sourceId && i.reply.text === extra.text && !['cancelled', 'dismissed'].includes(i.status));
            if (snapshot.sources.some(s => (s.id === extra.sourceId || s.messageIds.includes(extra.sourceId)) && s.status !== 'active')) return false;
            const captured = snapshot.sources.find(s => s.status === 'active' && (s.id === extra.sourceId || s.messageIds.includes(extra.sourceId))
              && s.scope.ownerId === localMemoryScope.ownerId && s.scope.agentId === localMemoryScope.agentId);
            if (captured?.messageIds.some(id => blocked.has(id))) return false;
            const message = sessionStore.getSessionMessages(matches[0]!.scope.sessionId ?? conversation.id).find(m => m.id === extra.sourceId && m.role === 'user');
            return (captured?.turn?.userMessage ?? message?.content) === extra.text
              && !graphL1Store?.reviews().some(r => r.sourceId === extra.sourceId && isUserSourceWithdrawal(r));
          }) && inferMemoryPrivacy(matches[0]!.turn!.userMessage).sensitivity === 'normal'
            && !graphL1Store?.reviews().some(r => r.sourceId === run.sourceId && (isUserSourceWithdrawal(r) || (r.reviewer === 'user' && r.status === 'pending')));
        },
        lookupContext: run => {
          const snapshot = workflowCaptures.snapshot();
          const blocked = memoryStore?.blockedSourceMessageIds(localMemoryScope) ?? new Set<string>();
          const root = snapshot.sources.find(s => s.status === 'active' && (s.id === run.sourceId || s.messageIds.includes(run.sourceId)));
          if (!root) return [];
          const ids = root.turn?.context?.recentMessages.filter(m => m.role === 'user').map(m => m.id).filter((id): id is string => !!id) ?? [];
          const history = sessionStore.getSessionMessages(root.scope.sessionId ?? conversation.id);
          return ids.flatMap(id => {
            if (blocked.has(id)) return [];
            if (snapshot.sources.some(s => s.messageIds.includes(id) && s.status !== 'active')) return [];
            const captured = snapshot.sources.find(s => s.status === 'active' && s.messageIds.includes(id)
              && s.scope.ownerId === localMemoryScope.ownerId && s.scope.agentId === localMemoryScope.agentId);
            const text = captured?.turn?.userMessage ?? history.find(m => m.id === id && m.role === 'user')?.content;
            if (!text || text.length > 4000 || inferMemoryPrivacy(text).sensitivity !== 'normal'
              || graphL1Store?.reviews().some(r => r.sourceId === id && isUserSourceWithdrawal(r))) return [];
            return [{ sourceId: id, text, sourceRevision: createHash('sha256').update(text).digest('hex') }];
          }).slice(-3);
        },
        readContext: id => {
          const blocked = memoryStore?.blockedSourceMessageIds(localMemoryScope) ?? new Set<string>();
          const source = workflowCaptures.snapshot().sources.find(s => (s.id === id || s.messageIds.includes(id))
            && !s.messageIds.some(messageId => blocked.has(messageId))
            && s.status === 'active' && s.scope.ownerId === localMemoryScope.ownerId && s.scope.agentId === localMemoryScope.agentId);
          const text = source?.turn?.userMessage;
          return text && text.length <= 4000 && inferMemoryPrivacy(text).sensitivity === 'normal'
            ? { sourceId: source!.messageIds[0] ?? source!.id, text, sourceRevision: createHash('sha256').update(text).digest('hex') } : undefined;
        },
      });
      memoryV4Lifecycle = createMemoryV4LifecycleService(v4Repository)
      // Remove legacy machine-only UIE publications that bypassed semantic fidelity review.
      // Human decisions and the original extraction remain available for review.
      const activeClaimIds = new Set(graphL1Store!.claims().map(claim => claim.ref.id))
      const publicationTasks = graphL1Store!.tasks().filter(task => task.state === 'published')
      const qualifierUpgradeRuns = new Set(publicationTasks.filter(task => {
        const claim = graphL1Store!.claims().find(claim => claim.ref.id === task.id)
        const raw = task.run.rawOutput as { graph?: { assertions?: { context?: Record<string, unknown> }[];
          facts?: { context?: Record<string, unknown> }[] } }
        const scalarContext = [...(raw?.graph?.assertions ?? []), ...(raw?.graph?.facts ?? [])].some(candidate =>
          Object.values(candidate.context ?? {}).some(value => value === null || typeof value === 'boolean' || typeof value === 'string'))
        const time = claim && parseGraphTimeInterval(claim.temporalSource.value)
        return task.review.reviewer === 'policy'
          && graphSemanticWorkflow?.list().some(item => item.run.id === task.run.id)
          && ((scalarContext && task.run.semanticReview?.contextVersion !== 'scalar-qualifiers-v1')
            || (time && claim?.validTime.kind === 'unknown'))
      }).map(task => task.run.id))
      for (const task of publicationTasks) {
        const qualifierUpgrade = task.review.reviewer === 'policy' && qualifierUpgradeRuns.has(task.run.id)
        const unreviewedUie = task.run.modelId === 'uie-base' && task.review.reviewer === 'policy'
          && !(task.run.semanticReview?.runId === task.run.id
            && task.run.semanticReview.candidateIds.includes(task.fact.sourceFactId))
        if (!activeClaimIds.has(task.id) || unreviewedUie || qualifierUpgrade) {
          if ((unreviewedUie || qualifierUpgrade) && task.factRef) memoryV4Lifecycle.deleteFact(task.factRef.id, localMemoryScope, 'suppress',
            { reason: unreviewedUie ? 'UIE 自动事实缺少语义复核，退回候选' : '按原始证据重新解析计划和时间字段',
              idempotencyKey: 'qualifier-fidelity-v1:' + task.id })
          graphL1Store!.retireClaims([task.id])
          if (unreviewedUie) graphL1Store!.recordReview({ ...task.review, status: 'pending',
            reason: 'uie-requires-semantic-review', reviewedAt: Date.now(), retrieval: { retain: false, reason: 'unreviewed-uie' } })
        }
      }
      reconcileGraphPublicationStatus()
      syncGraphSemantic()
      memoryCandidateReview = createMemoryCandidateReviewService(v4Repository)
      memoryV4Persistence = v4Persistence
      const snapshot = v4Repository.snapshot()
      if (snapshot.facts.some(fact => fact.metadata?.purgeCompletedAt !== undefined))
        v4Persistence.scrubBackups()
      if (isStageOneV4Shadow(snapshot)) {
        const migration = migrateV3SourceIntoV4(
          { load: persistence.loadReadOnly, storagePath: persistence.encryptedPath },
          v4Repository,
          { refreshMigrationOnlyTarget: true },
        )
        writeBootLog(`Memory V4 shadow ${migration.migrated ? 'migrated' : 'verified'}: ${migration.factCount} facts, ${migration.warningCount} warnings`)
      }
      memoryV4Shadow = createV4ShadowWriter({
        repository: v4Repository,
        onError: (error) => {
          memoryV4Error = errorMessage(error)
          writeBootLog(`Memory V4 shadow async flush failed: ${memoryV4Error}`)
        },
      })
      const recoveredV3 = persistence.loadReadOnly()
      if (recoveredV3) {
        memoryV4Reconciliation = memoryV4Shadow.reconcileV3Payload(recoveredV3)
        memoryV4Audit = auditV3V4Consistency(recoveredV3, v4Repository.snapshot())
        writeBootLog(`Memory V4 dual-write ready: ${memoryV4Reconciliation.mirroredCount}/${memoryV4Reconciliation.sourceCount} facts reconciled, ${memoryV4Reconciliation.deletedCount} tombstoned`)
        writeBootLog(`Memory V4 diff audit: ${(memoryV4Audit.consistency * 100).toFixed(4)}% exact, ${memoryV4Audit.issues.length} issues`)
      }
      const upgradeWriter = graphL1Writer, upgradeL1 = graphL1Store!, upgradeCaptures = graphCaptureRepository!
      const upgradeExtractions = graphExtractionStore!, upgradeNormalization = graphNormalizationStore!
      const current = () => upgradeWriter === graphL1Writer && upgradeL1 === graphL1Store
        && upgradeCaptures === graphCaptureRepository && upgradeExtractions === graphExtractionStore
        && upgradeNormalization === graphNormalizationStore
      const upgradeIds = memorySettings.extractionMode === 'open' || memorySettings.extractionMode === 'smart' ? []
        : upgradeL1.reviews().filter(r => r.status === 'pending' && r.reviewer === 'policy').map(r => r.id)
      graphSourceUpgradePromise = upgradeWriter.retryPending().then(async () => {
        for (let offset = 0; current() && offset < upgradeIds.length; offset += 20) {
          const result = await reassessRetainedUieGraphFacts({ extractions: upgradeExtractions,
            normalization: upgradeNormalization, l1: upgradeL1, writer: upgradeWriter,
            captureSnapshot: () => upgradeCaptures.snapshot(), scope: localMemoryScope,
            reviewIds: upgradeIds.slice(offset, offset + 20), isCurrent: current })
          writeBootLog(`Graph source-record upgrade: ${JSON.stringify(result)}`)
        }
        if (current() && graphSemanticWorkflow) {
          // Recover reviewed outbox entries locally. This mode cannot call the API
          // or replay sources under a different model/configuration.
          const ready = await graphSemanticWorkflow.retry(5, true, [...qualifierUpgradeRuns])
          for (const run of ready) {
            if (!current()) break
            await saveGraphExtraction(run)
          }
        }
      }).catch(error => writeBootLog(`Graph source-record upgrade failed: ${errorMessage(error)}`))
      if (memorySemanticActive && embeddingIndex) {
        try {
          const semanticGeneration = memoryV4ShadowGeneration
          const v4EmbeddingPersistence = createEncryptedFilePersistence({
            encryptedPath: memoryV4EmbeddingStoragePath,
            keyPath: memoryV4EmbeddingKeyPath,
            protectKey: key => safeStorage.encryptString(key.toString('base64')),
            unprotectKey: protectedKey => Buffer.from(safeStorage.decryptString(protectedKey), 'base64'),
          })
          const v4EmbeddingIndex = createMemoryEmbeddingIndex({ persistence: v4EmbeddingPersistence })
          const semanticIndex = createMemoryV4SemanticBackgroundIndex({
            index: v4EmbeddingIndex,
            model: SEMANTIC_MEMORY_FINGERPRINT,
            dimension: SEMANTIC_MEMORY_EXPECTED_DIMENSION,
            embed: semanticMemory.embed,
            seedFactVector: ({ sourceMemoryId, content }) =>
              embeddingIndex.get(sourceMemoryId, SEMANTIC_MEMORY_FINGERPRINT, content),
          })
          memoryV4EmbeddingIndex = v4EmbeddingIndex
          memoryV4SemanticBackgroundIndex = semanticIndex
          const seeded = semanticIndex.seed(v4Repository.snapshot())
          writeBootLog(`Memory V4 learned semantic index seeded: ${seeded.ready}/${seeded.total}, revision ${seeded.semanticRevision}`)
          void semanticIndex.prepare(v4Repository.snapshot(), {
            batchSize: 8,
            maxItems: 128,
            shouldCancel: () => semanticGeneration !== memoryV4ShadowGeneration,
          })
            .then((status) => {
              if (semanticGeneration === memoryV4ShadowGeneration)
                writeBootLog(`Memory V4 learned semantic background preparation: ${status.ready}/${status.total}, ${status.pending} pending`)
            })
            .catch((error) => {
              memoryV4SemanticError = errorMessage(error)
              writeBootLog(`Memory V4 learned semantic background preparation failed: ${memoryV4SemanticError}`)
            })
        }
        catch (error) {
          memoryV4EmbeddingIndex = undefined
          memoryV4SemanticBackgroundIndex = undefined
          memoryV4SemanticError = errorMessage(error)
          writeBootLog(`Memory V4 learned semantic side index disabled; hash fallback remains active: ${memoryV4SemanticError}`)
        }
      }
      const shadowWorkerClient = createMemoryV4ShadowWorkerClient({
        workerPath: join(moduleDir, 'memory-v4-shadow-worker.js'),
        getSnapshot: () => v4Repository.snapshot(),
        getSemanticIndex: snapshot => buildV4SemanticIndexSnapshot(snapshot),
        timeoutMs: 1_000,
      })
      memoryV4ShadowWorkerClient = shadowWorkerClient
      try {
        const evaluationPersistence = createEncryptedFilePersistence({
          encryptedPath: memoryV4ShadowEvaluationPath,
          keyPath: memoryV4ShadowEvaluationKeyPath,
          protectKey: key => safeStorage.encryptString(key.toString('base64')),
          unprotectKey: protectedKey => Buffer.from(safeStorage.decryptString(protectedKey), 'base64'),
        })
        const evaluationStore = createMemoryV4ShadowEvaluationStore({
          persistence: evaluationPersistence,
          maxRecords: 4_096,
          flushDelayMs: 5_000,
          encrypted: true,
          onPersistenceError: (error) => {
            memoryV4ShadowEvaluationError = errorMessage(error)
            writeBootLog(`Memory V4 shadow evaluation persistence failed: ${memoryV4ShadowEvaluationError}`)
          },
        })
        memoryV4ShadowEvaluationPersistence = evaluationPersistence
        memoryV4ShadowEvaluationStore = evaluationStore
        memoryV4ShadowComparator = createV3V4ShadowComparator({
          queryHasher: createV4ShadowQueryHasher(),
          sink: evaluationStore,
          onSinkError: (error) => {
            memoryV4ShadowEvaluationError = errorMessage(error)
            writeBootLog(`Memory V4 shadow evaluation persistence failed: ${memoryV4ShadowEvaluationError}`)
          },
        })
        writeBootLog(`Memory V4 persistent shadow evaluation ready: ${evaluationStore.status().comparisons} comparisons retained`)
      }
      catch (error) {
        memoryV4ShadowEvaluationPersistence = undefined
        memoryV4ShadowEvaluationStore = undefined
        memoryV4ShadowEvaluationError = errorMessage(error)
        memoryV4ShadowComparator = createV3V4ShadowComparator()
        writeBootLog(`Memory V4 persistent shadow evaluation disabled: ${memoryV4ShadowEvaluationError}`)
      }
      try {
        const feedbackPersistence = createEncryptedFilePersistence({
          encryptedPath: memoryV4InternalFeedbackPath,
          keyPath: memoryV4InternalFeedbackKeyPath,
          protectKey: key => safeStorage.encryptString(key.toString('base64')),
          unprotectKey: protectedKey => Buffer.from(safeStorage.decryptString(protectedKey), 'base64'),
        })
        const feedbackStore = createMemoryV4InternalFeedbackStore({
          persistence: feedbackPersistence,
          encrypted: true,
          maxReviews: 4_096,
          flushDelayMs: 1_000,
          onPersistenceError: (error) => {
            memoryV4InternalFeedbackError = errorMessage(error)
            writeBootLog(`Memory V4 Internal feedback persistence failed: ${memoryV4InternalFeedbackError}`)
          },
        })
        memoryV4InternalFeedbackPersistence = feedbackPersistence
        memoryV4InternalFeedbackStore = feedbackStore
        writeBootLog(`Memory V4 encrypted Internal feedback ready: ${feedbackStore.status().retainedReviews} reviews retained`)
      }
      catch (error) {
        memoryV4InternalFeedbackPersistence = undefined
        memoryV4InternalFeedbackStore = undefined
        memoryV4InternalFeedbackError = errorMessage(error)
        writeBootLog(`Memory V4 Internal feedback disabled; retrieval remains active: ${memoryV4InternalFeedbackError}`)
      }
      memoryV4ShadowTaskQueue = createMemoryV4ShadowTaskQueue<MemoryV4ShadowComparisonTask>({
        maxPending: 4,
        maxQueueAgeMs: 10_000,
        maxTaskMs: 1_250,
        run: async (task) => {
          if (task.generation !== memoryV4ShadowGeneration) {
            if (task.internalReviewRequestId)
              memoryV4InternalReview.drop(task.internalReviewRequestId, 'generation-invalidated')
            return
          }
          try {
            const semanticQuery = await prepareMemoryV4SemanticQuery(task.query)
            const v4 = await shadowWorkerClient.recall(task.query, {
              scope: task.scope,
              limit: Math.max(1, Math.min(50, task.v3RetrievedIds.length || 10)),
              sharePolicies: ['allow-remote'],
              sensitivities: memorySettings.remotePolicy === 'allow-private'
                ? ['normal', 'private']
                : ['normal'],
              ...(semanticQuery ? { semanticQuery } : {}),
            })
            if (task.generation !== memoryV4ShadowGeneration) {
              if (task.internalReviewRequestId)
                memoryV4InternalReview.drop(task.internalReviewRequestId, 'generation-invalidated')
              return
            }
            const comparison = memoryV4ShadowComparator.compare(
              task.query,
              task.v3RetrievedIds,
              task.v3InjectedIds,
              v4,
            )
            if (task.internalReviewRequestId) {
              const review = memoryV4InternalReview.complete(task.internalReviewRequestId, comparison, v4)
              if (review)
                memoryV4InternalFeedbackStore?.registerReview(review)
              writeBootLog('Memory V4 internal candidate review completed; V3 remained authoritative')
            }
          }
          catch (error) {
            if (task.internalReviewRequestId)
              memoryV4InternalReview.drop(task.internalReviewRequestId, 'worker-failure')
            if (task.generation !== memoryV4ShadowGeneration)
              return
            memoryV4ShadowComparator.recordFailure(task.query, error)
            throw error
          }
        },
        onError: error => writeBootLog(`Memory V4 shadow read comparison failed: ${errorMessage(error)}`),
        onDrop: (reason, task) => {
          if (task.internalReviewRequestId)
            memoryV4InternalReview.drop(task.internalReviewRequestId, reason)
          writeBootLog(`Memory V4 shadow comparison dropped: ${reason}`)
        },
      })
      if (memorySettings.v4RolloutStage === 'internal') {
        memoryV4InternalReview.setEnabled(true)
        writeBootLog('Memory V4 internal candidate review enabled; review does not modify official read mode')
      }
      // Stage-four offline consolidation: rebuild session/day/topic/entity/
      // temporal-stage summaries in
      // derivedArtifacts while the user is idle. Runs are idempotent, so an
      // interrupted pass simply resumes on the next idle window. The idle pass
      // first refreshes capacity tiering, archives a bounded batch of cold
      // overflow facts and merges duplicate episodes, then consolidates
      // summaries against the cleaned-up graph.
      const tiering = createMemoryTieringService(v4Repository)
      const consolidationGeneration = memoryV4ShadowGeneration
      memoryV4ConsolidationRunner = createIdleConsolidationRunner({
        service: createMemoryConsolidationService(v4Repository),
        scope: localMemoryScope,
        isIdle: () => app.isReady() && powerMonitor.getSystemIdleTime() >= MEMORY_CONSOLIDATION_IDLE_SECONDS,
        intervalMs: 5 * 60_000,
        cooldownMs: 30 * 60_000,
        runOptions: {
          granularity: ['session', 'day', 'topic', 'entity', 'stage'],
          maxRuntimeMs: 10_000,
        },
        onIdle: async () => {
          if (memoryV4SemanticBackgroundIndex) {
            const semanticStatus = await memoryV4SemanticBackgroundIndex.prepare(
              v4Repository.snapshot(),
              {
                batchSize: 8,
                maxItems: 64,
                shouldCancel: () => consolidationGeneration !== memoryV4ShadowGeneration,
              },
            )
            writeBootLog(`Memory V4 learned semantic idle preparation: ${semanticStatus.ready}/${semanticStatus.total}, ${semanticStatus.pending} pending`)
          }
          const tieringReport = await tiering.run(localMemoryScope)
          writeBootLog(`Memory V4 tiering: hot ${tieringReport.tierCounts.hot}, warm ${tieringReport.tierCounts.warm}, cold ${tieringReport.tierCounts.cold}, quarantine ${tieringReport.tierCounts.quarantine}, ${tieringReport.archiveCandidates.length} archive candidates`)
          const archived = await tiering.archiveColdFacts(localMemoryScope, { maxArchives: 8 })
          if (archived.archived.length > 0)
            writeBootLog(`Memory V4 archived ${archived.archived.length} cold facts (${archived.failed.length} failed)`)
          const dedup = mergeDuplicateEpisodes(v4Repository, localMemoryScope)
          if (dedup.mergedEpisodes > 0)
            writeBootLog(`Memory V4 episode dedup merged ${dedup.mergedEpisodes} duplicates (${dedup.migratedEvidence} evidence links migrated)`)
        },
        onError: error => writeBootLog(`Memory V4 idle consolidation failed: ${errorMessage(error)}`),
      })
      memoryV4ConsolidationRunner.start()
      writeBootLog('Memory V4 idle consolidation runner started')
    }
    catch (error) {
      // V4 remains a shadow copy in stage two. Its failure must never disable
      // the verified V3 runtime or overwrite the V3 source.
      memoryV4ShadowTaskQueue?.stop()
      memoryV4ShadowTaskQueue = undefined
      memoryV4ShadowWorkerClient?.stop()
      memoryV4ShadowWorkerClient = undefined
      memoryV4Shadow = undefined
      memoryV4InternalReview.setEnabled(false)
      memoryV4Error = errorMessage(error)
      writeBootLog(`Memory V4 shadow initialization failed: ${memoryV4Error}`)
    }
  }
  catch (error) {
    memoryInitializationError = errorMessage(error)
    writeBootLog(`long-term memory disabled after initialization error: ${memoryInitializationError}`)
  }
}

function effectiveMemoryV4RolloutStage(): MemoryV4RolloutStageSetting {
  return memoryV4Shadow && memoryV4ShadowWorkerClient && memoryV4InternalReview.status().enabled
    ? 'internal'
    : 'shadow'
}

function isStageOneV4Shadow(snapshot: ReturnType<ReturnType<typeof createMemoryV4Repository>['snapshot']>): boolean {
  const empty = snapshot.dualWriteState === undefined
    && snapshot.facts.length === 0
    && snapshot.episodes.length === 0
    && snapshot.migrationManifests.length === 0
  const migrationOnly = snapshot.dualWriteState === undefined
    && snapshot.candidates.length === 0
    && snapshot.retrievalEvents.length === 0
    && snapshot.migrationManifests.length <= 1
    && snapshot.facts.length === snapshot.legacyImports.length
    && snapshot.facts.every(fact => fact.extractorVersion === 'v3-import')
    && snapshot.episodes.every(episode => episode.provenance !== 'native-v4')
  return empty || migrationOnly
}

async function prepareMemoryV4SemanticQuery(
  query: string,
): Promise<{ model: string; vector: number[] } | undefined> {
  if (!memorySemanticActive)
    return undefined
  try {
    const semanticQuery = {
      model: SEMANTIC_MEMORY_FINGERPRINT,
      vector: await semanticMemory.embed(query),
    }
    memoryV4SemanticError = ''
    return semanticQuery
  }
  catch (error) {
    const message = errorMessage(error)
    if (message !== memoryV4SemanticError)
      writeBootLog(`Memory V4 learned semantic query unavailable; caller fallback will apply: ${message}`)
    memoryV4SemanticError = message
    return undefined
  }
}

function scheduleV4ShadowComparison(
  query: string,
  scope: { ownerId: string; agentId?: string; sessionId?: string },
  v3RetrievedIds: readonly string[],
  v3InjectedIds: readonly string[],
): void {
  const queue = memoryV4ShadowTaskQueue
  if (!queue)
    return
  const internalReviewRequestId = memoryV4InternalReview.claim(query)
  // The bounded queue runs after V3 selection, never contributes to the model
  // prompt and drops overload/stale work instead of delaying future chat turns.
  queue.enqueue({
    generation: memoryV4ShadowGeneration,
    query,
    scope,
    v3RetrievedIds: [...v3RetrievedIds],
    v3InjectedIds: [...v3InjectedIds],
    ...(internalReviewRequestId ? { internalReviewRequestId } : {}),
  })
}

function invalidateMemoryV4ShadowComparisons(): void {
  memoryV4ShadowGeneration += 1
  memoryV4InternalReview.cancelAll()
  memoryV4ShadowTaskQueue?.clearPending()
  memoryV4ShadowWorkerClient?.cancelAll()
}

async function prepareDesktopGraphRecall(flushCaptures: () => Promise<void>): Promise<void> {
  await graphSourceUpgradePromise
  // Load and integrity-check outside the per-query retrieval budget; reuse across partitions.
  if (memorySemanticActive && graphLocalSelectionEnabled()) await graphLocalSelection.prepare()
  const repository = memoryV4Repository, semantic = graphSemanticRepository, projection = graphL1ProjectionRepository
  const store = graphL1Store, shadow = memoryV4Shadow
  await prepareGraphRecallInputs({ flushCaptures, flushV4: () => { shadow?.flush() },
    isCurrent: () => repository === memoryV4Repository && semantic === graphSemanticRepository
      && projection === graphL1ProjectionRepository && store === graphL1Store && shadow === memoryV4Shadow,
    syncL1: async () => {
      if (!repository || !semantic || !projection || !store) return
      const result = await semantic.syncFromClaims(store, repository, currentGraphPredicateRegistry(), localMemoryScope)
      if (!result.ok || !projection.sync()) throw new Error('Current accepted L1 publication unavailable')
      // Use the same serialized publication queue as explicit relation admission. This does not approve NLI candidates.
      if (repository !== memoryV4Repository || semantic !== graphSemanticRepository || projection !== graphL1ProjectionRepository)
        throw new Error('Graph memory reloaded during L1 synchronization')
      await queueGraphL2Sync()
      if (memorySemanticActive) {
        const entityProjection = projection.snapshot(), entityIndex = graphEntityEmbeddingIndex
        const remotePolicy = memorySettings.remotePolicy
        const l1Persistence = graphL1Persistence
        if (entityProjection?.manifest.state === 'ready' && l1Persistence) await prepareV4EntityVectors({
          memory: {
            repository, persistence: l1Persistence, includeOwnedSessions: true,
            acceptedBundle: () => selectRetrievableGraphBundle(projection.snapshot()?.semanticBundle, store.tasks()),
            authorizeScope: scope => scope.ownerId === localMemoryScope.ownerId && scope.agentId === localMemoryScope.agentId
              && scope.sessionId === undefined && memoryV4Repository === repository,
            canRead: canReadGraphRecord, countTokens: countGraphTokens,
          },
          scope: localMemoryScope, index: entityIndex, model: SEMANTIC_MEMORY_FINGERPRINT,
          sharePolicies: remotePolicy === 'disabled' ? [] : ['allow-remote'],
          sensitivities: remotePolicy === 'allow-private' ? ['normal', 'private'] : ['normal'],
          textMode: graphEntityRetrievalTextMode(),
          embed: text => semanticMemory.embed(text),
          isCurrent: () => memorySemanticActive && graphEntityEmbeddingIndex === entityIndex
            && memoryV4Repository === repository && graphL1Store === store && graphL1Persistence === l1Persistence
            && memorySettings.remotePolicy === remotePolicy
            && graphL1ProjectionRepository === projection
            && projection.snapshot()?.manifest.manifestId === entityProjection.manifest.manifestId,
        })
      }
    } })
}

function graphEntityRetrievalTextMode(): 'name-only' | 'claim-fragments' {
  return process.env.CONTINUUM_GRAPH_ENTITY_TEXT === 'name-only' ? 'name-only' : 'claim-fragments'
}

function graphLocalSelectionEnabled(): boolean {
  return process.env.CONTINUUM_GRAPH_EVIDENCE_SELECTION !== 'cosine'
    && !['lexical', 'hybrid', 'vector'].includes(process.env.CONTINUUM_GRAPH_RETRIEVAL ?? '')
}

function canReadGraphRecord(record: { sharePolicy: string; sensitivity: string }): boolean {
  return memorySettings.remotePolicy !== 'disabled' && record.sharePolicy === 'allow-remote'
    && (record.sensitivity === 'normal'
      || (record.sensitivity === 'private' && memorySettings.remotePolicy === 'allow-private'))
}

function createDesktopGraphMemory() {
  const repository = memoryV4Repository, l1Persistence = graphL1Persistence
  return repository && l1Persistence
    ? createV4L2Memory({
        repository, persistence: l1Persistence,
        entityRetrievalTextMode: graphEntityRetrievalTextMode(),
        supplementaryRecall: process.env.CONTINUUM_GRAPH_QUERY_EXPANSION !== 'off',
        ...(graphLocalSelectionEnabled()
          ? { candidateSelection: graphLocalSelection.selection() } : {}),
        // Trusted launch-time controls for comparison; ordinary requests cannot switch retrieval policies.
        retrievalMode: process.env.CONTINUUM_GRAPH_RETRIEVAL === 'hybrid' ? 'hybrid'
          : process.env.CONTINUUM_GRAPH_RETRIEVAL === 'lexical' ? 'lexical'
            : process.env.CONTINUUM_GRAPH_RETRIEVAL === 'vector' ? 'vector' : 'entity-vector',
        includeOwnedSessions: true,
        nativeRelations: { projection: () => graphL1ProjectionRepository?.snapshot(), repository: () => graphRelationRepository },
        acceptedBundle: () => selectRetrievableGraphBundle(graphL1ProjectionRepository?.snapshot()?.semanticBundle, graphL1Store?.tasks() ?? []),
        authorizeScope: scope => memoryV4Repository === repository
          && graphL1Persistence === l1Persistence
          && scope.ownerId === localMemoryScope.ownerId
          && scope.agentId === localMemoryScope.agentId && scope.sessionId === undefined,
        canRead: canReadGraphRecord,
        countTokens: countGraphTokens,
        utcOffsetMinutes: -new Date().getTimezoneOffset(),
        ...(memorySemanticActive && memoryV4EmbeddingIndex ? {
          // Relation ranking is a separate comparison switch from L1 retrieval (lexical stays unranked).
          relationPriority: process.env.CONTINUUM_GRAPH_RELATION_ORDER === 'source' ? undefined : { windowSize: 4, timeoutMs: 200 },
          entitySemantic: {
            queryExpansion: process.env.CONTINUUM_GRAPH_QUERY_EXPANSION !== 'off',
            model: SEMANTIC_MEMORY_FINGERPRINT, dimensions: SEMANTIC_MEMORY_EXPECTED_DIMENSION,
            index: { get: (id: string, model: string, content: string) =>
              memorySemanticActive ? graphEntityEmbeddingIndex.get(id, model, content) : undefined },
            embedQuery: prepareMemoryV4SemanticQuery,
          },
          semantic: {
            queryExpansion: process.env.CONTINUUM_GRAPH_QUERY_EXPANSION !== 'off',
            model: SEMANTIC_MEMORY_FINGERPRINT,
            dimensions: SEMANTIC_MEMORY_EXPECTED_DIMENSION,
            // Exact canonical text lookup rejects cached vectors for old fact contents.
            index: { get: (id: string, model: string, content: string) =>
              memorySemanticActive ? memoryV4EmbeddingIndex?.get(id, model, content) : undefined },
            embedQuery: prepareMemoryV4SemanticQuery,
          },
        } : {}),
      })
    : undefined
}

function memoryForRemoteRuntime() {
  if (!memory)
    return undefined
  const localMemory = memory
  const worker = memoryV4ShadowWorkerClient
  const graph = graphMemoryEnabled ? createDesktopGraphMemory() : undefined
  const readController = createMemoryV4ReadController({
    mode: config.memoryV4ReadMode,
    recallV3: (query, scope, options) => localMemory.recallAdaptive!(query, scope, options),
    ...(worker
      ? {
          recallV4: async (query, options) => {
            const semanticQuery = await prepareMemoryV4SemanticQuery(query)
            return worker.recall(query, {
              ...options,
              ...(semanticQuery ? { semanticQuery } : {}),
            })
          },
        }
      : {}),
    isV4Ready: () => !!memoryV4Shadow
      && !!memoryV4Repository
      && memoryV4ShadowWorkerClient === worker
      && !!worker
      && !worker.status().active,
    onDecision: (decision, { query, scope }) => {
      const workerStatus = worker?.status()
      const snapshot = memoryV4Repository?.snapshot()
      memoryV4RuntimeObservability.record(decision, {
        workerEpoch: memoryV4ShadowGeneration,
        workerAvailable: !!workerStatus,
        memoryAvailable: !!snapshot,
        ...(workerStatus ? { worker: workerStatus } : {}),
        ...(workerStatus?.lastIndex ? { index: workerStatus.lastIndex } : {}),
        ...(snapshot
          ? {
              memory: {
                revision: snapshot.revision,
                facts: snapshot.facts.length,
                factVersions: snapshot.factVersions.length,
                derivedArtifacts: snapshot.derivedArtifacts.length,
              },
            }
          : {}),
      })
      memoryV4Shadow?.enqueueRetrieval({
        query,
        scope,
        retrievedMemoryIds: [...decision.result.retrievedMemoryIds],
        injectedMemoryIds: [...decision.result.injectedMemoryIds],
        queryType: 'adaptive',
        answerModel: apiConfig.model,
      })
      if (decision.requestedMode === 'v3') {
        scheduleV4ShadowComparison(
          query,
          scope,
          decision.result.retrievedMemoryIds,
          decision.result.injectedMemoryIds,
        )
      }
    },
  })
  memoryV4ReadController = readController
  writeBootLog(`Memory V4 official read controller ready: ${config.memoryV4ReadMode}, per-request V3 fallback enabled`)
  return {
    ...localMemory,
    ...(graph ? { graph } : {}),
    async beginRecallTurn(scope: Parameters<typeof localMemory.list>[0]) {
      const v4 = memoryV4Repository?.snapshot();
      const published = new Set(graphL1Store?.tasks().filter(t => t.state === 'published').map(t => t.id) ?? []);
      const legacyVisible = await localMemory.beginRecallTurn!(scope);
      const visible = new Set<string>();
      for (const fact of v4?.facts ?? []) if (fact.scope.ownerId === scope.ownerId
        && (scope.agentId === undefined || fact.scope.agentId === scope.agentId)
        && (scope.sessionId === undefined || fact.scope.sessionId === scope.sessionId)
        && (!fact.metadata?.graphTaskId || published.has(String(fact.metadata.graphTaskId)))) visible.add(JSON.stringify([fact.id, fact.canonicalText]));
      return (fragment: Awaited<ReturnType<typeof localMemory.list>>[number]) => legacyVisible(fragment)
        || visible.has(JSON.stringify([fragment.id, fragment.content]));
    },
    async validateRecall(fragments: Awaited<ReturnType<typeof localMemory.list>>, scope: Parameters<typeof localMemory.list>[0]) {
      if (memorySettings.remotePolicy === 'disabled') return [];
      const rows = await localMemory.validateRecall!(fragments, scope), facts = memoryV4Repository?.snapshot().facts ?? [];
      return fragments.filter(m => rows.some(row => row.id === m.id && row.content === m.content
        && !['suppressed', 'deleted', 'orphaned', 'expired'].includes(row.status ?? '') && row.sharePolicy === 'allow-remote'
        && (row.sensitivity === 'normal' || memorySettings.remotePolicy === 'allow-private'))
        || facts.some(f => f.id === m.id && f.canonicalText === m.content && f.status === 'active'
          && f.invalidatedAt === undefined && f.sharePolicy === 'allow-remote'
          && (f.sensitivity === 'normal' || memorySettings.remotePolicy === 'allow-private')));
    },
    async recall(query: string, scope: Parameters<typeof localMemory.recall>[1], topK = 5) {
      if (memorySettings.remotePolicy === 'disabled')
        return []
      const recalled = await localMemory.recall(query, scope, topK, {
        sharePolicies: ['allow-remote'],
        sensitivities: memorySettings.remotePolicy === 'allow-private'
          ? ['normal', 'private']
          : ['normal'],
      })
      memoryV4Shadow?.enqueueRetrieval({
        query,
        scope,
        retrievedMemoryIds: recalled.map(item => item.id),
        injectedMemoryIds: recalled.map(item => item.id),
        queryType: 'fixed',
        answerModel: apiConfig.model,
      })
      scheduleV4ShadowComparison(query, scope, recalled.map(item => item.id), recalled.map(item => item.id))
      return recalled
    },
    async recallAdaptive(query: string, scope: Parameters<typeof localMemory.recall>[1]) {
      if (memorySettings.remotePolicy === 'disabled') {
        return {
          memories: [], retrievedMemoryIds: [], injectedMemoryIds: [],
          candidateCount: 0, evaluatedCount: 0, batchesEvaluated: 0,
          stopReason: 'no-candidates' as const,
        }
      }
      return readController.recallAdaptive(query, scope, {
        sharePolicies: ['allow-remote'],
        sensitivities: memorySettings.remotePolicy === 'allow-private'
          ? ['normal', 'private']
          : ['normal'],
      })
    },
  }
}

// ── Runtime ─────────────────────────────────────────────
const hooks = createChatHooks()
hooks.onTokenLiteral(async (literal) => {
  sendPartitionEvent('chat:token', literal)
})

let runtime: ReturnType<typeof createAgentRuntime>

function rebuildRuntime() {
  const llm = createOpenAILlm({ apiKey: apiConfig.apiKey, baseURL: apiConfig.baseURL })
  const remoteMemory = memoryForRemoteRuntime()
  if (graphMemoryEnabled && !remoteMemory?.graph)
    writeBootLog('Graph recall adapter is unavailable; the current runtime uses the configured V3/V4 read path')
  runtime = createAgentRuntime({
    persona: { systemPrompt: currentPersona, model: apiConfig.model },
    llm, session: sessionStore, memory: remoteMemory,
    resolveMemoryScope: () => localMemoryScope,
    ...(graphMemoryEnabled && remoteMemory?.graph && !memorySettings.openSourceRecallEnabled ? { graphRecall: {
      countTokens: countGraphTokens,
      answerability: { reviewer: createLLMGraphAnswerabilityReviewer(llm), timeoutMs: 12000, maxInputTokens: 16000 },
      awaitCaptureWrites: () => prepareDesktopGraphRecall(async () => {}),
      beginTurn: () => {
        const snapshot = memoryV4Repository?.snapshot();
        const ready = graphL1ProjectionRepository?.snapshot();
        const published = ready?.manifest.state === 'ready'
          ? selectRetrievableGraphBundle(ready.semanticBundle, graphL1Store?.tasks() ?? [])?.claims ?? [] : [];
        const factKey = (id: string, version: number) => JSON.stringify([id, version]);
        const publishedFacts = new Set(published.map(claim => factKey(claim.fact.id, claim.fact.version)));
        const versions = new Map<string, number>();
        for (const version of snapshot?.factVersions ?? [])
          versions.set(version.factId, Math.max(versions.get(version.factId) ?? 0, version.version));
        const visibleFacts = (snapshot?.facts ?? []).flatMap(f => {
          const version = versions.get(f.id);
          return version && (!f.metadata?.graphTaskId || publishedFacts.has(factKey(f.id, version)))
            ? [{ kind: 'v4-fact' as const, id: f.id, version }] : [];
        });
        const knownAt = Date.now();
        return (query, scope) => ({ protocolVersion: 'memory-graph/v1' as const, recallId: crypto.randomUUID(), query, scope: { ...localMemoryScope, ...(scope.sessionId ? { sessionId: scope.sessionId } : {}) },
          temporal: { knownAt, valid: { kind: 'at' as const, at: knownAt } }, visibleFacts,
          mode: 'direct-only' as const, budget: { ...V4_L2_BUDGET }, sharePolicies: ['allow-remote' as const],
          sensitivities: memorySettings.remotePolicy === 'allow-private' ? ['normal' as const, 'private' as const] : ['normal' as const] });
      },
      createRequest: (query: string) => {
        const timestamp = Date.now()
        return { protocolVersion: 'memory-graph/v1' as const, recallId: crypto.randomUUID(), query,
          scope: localMemoryScope, temporal: { knownAt: timestamp, valid: { kind: 'at' as const, at: timestamp } },
          mode: 'direct-only' as const, budget: { ...V4_L2_BUDGET },
          sharePolicies: ['allow-remote' as const],
          sensitivities: memorySettings.remotePolicy === 'allow-private'
            ? ['normal' as const, 'private' as const] : ['normal' as const] }
      },
    } } : {}),
    ...(memorySettings.openSourceRecallEnabled && remoteMemory ? { sourceRecall: {
      countTokens: countGraphTokens,
      maxTokens: 4000,
      beginTurn: beginDesktopSourceRecall,
      recall: (query, scope) => beginDesktopSourceRecall()(query, scope),
    } } : {}),
    tools: tools.hasTools() ? tools : undefined,
    maxToolRounds: 10,
    hooks,
  })
}

function beginDesktopSourceRecall() {
  const captures = graphCaptureRepository, extractions = graphExtractionStore;
  const versions = new Map(captures?.snapshot().sources.map(s => [s.id, s.revision]) ?? []);
  const runIds = new Set(extractions?.list().map(r => r.id) ?? []);
  const allowed = () => memorySettings.openSourceRecallEnabled && memorySettings.remotePolicy !== 'disabled'
  return async (query: string, _scope: { ownerId: string; agentId?: string; sessionId?: string }) => {
    if (!captures || !extractions || captures !== graphCaptureRepository || extractions !== graphExtractionStore
      || !allowed() || _scope.ownerId !== localMemoryScope.ownerId
      || (_scope.agentId !== undefined && _scope.agentId !== localMemoryScope.agentId)) return [];
    const blocked = new Set(graphL1Store?.reviews().filter(isUserSourceWithdrawal).map(r => r.sourceId) ?? []);
    for (const id of memoryStore?.blockedSourceMessageIds(localMemoryScope) ?? []) blocked.add(id);
    if (captures !== graphCaptureRepository || !allowed()) return [];
    return recallOpenSources({ captures: captures.snapshot(),
      extractions: { list: () => extractions.list().filter(r => runIds.has(r.id)), openReviews: () => extractions.openReviews() },
      scope: { ...localMemoryScope, ...(_scope.sessionId ? { sessionId: _scope.sessionId } : {}) }, query, canRead: source => versions.get(source.id) === source.revision
        && !source.messageIds.some(id => blocked.has(id)) && inferMemoryPrivacy(source.turn!.userMessage).sensitivity === 'normal' });
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function auditPurgedMemory(memoryId: string, factId: string, originalContent: string): string[] {
  const residual: string[] = []
  const snapshot = memoryV4Repository?.snapshot()
  if (!snapshot)
    return ['V4 快照不可用']
  const fact = snapshot.facts.find(entry => entry.id === factId)
  if (!fact || fact.status !== 'deleted' || fact.canonicalText !== '[purged]')
    residual.push('V4 事实未成为已清除墓碑')
  const serialized = JSON.stringify(snapshot)
  if (originalContent && serialized.includes(originalContent))
    residual.push('V4 当前快照仍含原正文')
  if (snapshot.factVersions.some(version => version.factId === factId && version.canonicalText !== '[purged]'))
    residual.push('V4 历史版本仍含正文')
  const episodeIds = new Set(snapshot.evidenceLinks.filter(link => link.factId === factId).map(link => link.episodeId))
  if (snapshot.episodes.some(episode => episodeIds.has(episode.id)
    && (episode.contentState !== 'deleted' || episode.content !== undefined || episode.contentHash !== undefined)))
    residual.push('V4 独占证据仍可恢复')
  if (snapshot.legacyImports.some(legacy => legacy.factId === factId && JSON.stringify(legacy.raw).includes(originalContent)))
    residual.push('V4 旧版导入副本仍含正文')
  if (snapshot.facts.some(entry => entry.metadata?.v3SourceId === memoryId && entry.id !== factId && entry.status !== 'deleted'))
    residual.push('V4 存在同源活动事实')
  return residual
}

async function prepareMemoryPurge(id: unknown) {
  if (!memory?.purge || !memoryV4Repository || !memoryV4Lifecycle || !memoryV4Persistence)
    return { ok: false as const, error: '彻底清除仅在 V4 安全生命周期与加密日志正常工作时开放。' }
  const normalizedId = typeof id === 'string' ? id.trim() : ''
  const item = normalizedId ? (await memory.list(localMemoryScope, 100_000)).find(entry => entry.id === normalizedId) : undefined
  if (!item)
    return { ok: false as const, error: '没有找到该记忆。' }
  const challenge = purgeConfirmation.prepare(normalizedId)
  return {
    ok: true as const,
    ...challenge,
    warning: '此操作不可恢复，将删除该记忆正文、历史版本、独占证据、索引日志和受管备份中的可恢复副本。',
  }
}

async function confirmMemoryPurge(input: { id?: unknown; token?: unknown; phrase?: unknown }) {
  openContextVectorCache.clear()
  if (!memory?.purge || !memoryV4Repository || !memoryV4Lifecycle || !memoryV4Persistence)
    return { ok: false as const, error: '彻底清除当前不可用。' }
  const id = typeof input?.id === 'string' ? input.id.trim() : ''
  const token = typeof input?.token === 'string' ? input.token : ''
  const phrase = typeof input?.phrase === 'string' ? input.phrase.trim() : ''
  if (!purgeConfirmation.consume(id, token, phrase))
    return { ok: false as const, error: '确认已失效或确认短语不正确，请重新发起。' }

  // Destroy any worker-held snapshot before removing recoverable copies.
  invalidateMemoryV4ShadowComparisons()
  memoryV4Shadow?.flush()
  const snapshot = memoryV4Repository.snapshot()
  const fact = snapshot.facts.find(entry => entry.metadata?.v3SourceId === id)
  if (!fact)
    return { ok: false as const, error: 'V4 中没有对应事实，为避免部分删除已停止操作。' }
  const episodeIds = new Set(snapshot.evidenceLinks.filter(link => link.factId === fact.id).map(link => link.episodeId))
  const sharedEvidenceCount = snapshot.evidenceLinks.filter(link => episodeIds.has(link.episodeId)
    && link.factId !== fact.id && link.active).length
  if (sharedEvidenceCount > 0) {
    return {
      ok: false as const,
      error: `该记忆与其他事实共享 ${sharedEvidenceCount} 条原始证据。为避免残留或误删，请先删除关联来源/事实，再重新彻底清除。`,
    }
  }
  const originalContent = fact.canonicalText
  let lifecycle
  let removedV3 = false
  try {
    lifecycle = memoryV4Lifecycle.deleteFact(fact.id, localMemoryScope, 'purge', {
      reason: 'User confirmed irreversible purge in memory manager.',
      idempotencyKey: `desktop-purge:${id}:${token}`,
    })
    // Make the V4 privacy deletion durable and remove recoverable managed V4
    // copies before deleting the authoritative V3 record.
    memoryV4Persistence.scrubBackups()
    memoryV4EmbeddingIndex?.removeMemoryIds([fact.id, ...snapshot.derivedArtifacts
      .filter(artifact => artifact.sourceFactIds.includes(fact.id))
      .map(artifact => artifact.id)])
    memoryV4EmbeddingIndex?.scrubBackups()
    memoryV4InternalFeedbackStore?.removeFactIds([fact.id, id])
    memoryV4InternalFeedbackStore?.flush()
    memoryV4InternalFeedbackPersistence?.scrubBackups()
    removedV3 = await memory.purge(id, localMemoryScope)
    memoryV4Shadow!.flush()
    const recoveredV3 = memoryPersistence?.loadReadOnly()
    if (recoveredV3) {
      memoryV4Reconciliation = memoryV4Shadow!.reconcileV3Payload(recoveredV3)
      memoryV4Audit = auditV3V4Consistency(recoveredV3, memoryV4Repository.snapshot())
    }
    memoryV4Persistence.scrubBackups()
    memoryV4EmbeddingIndex?.scrubBackups()
    memoryV4InternalFeedbackPersistence?.scrubBackups()
  }
  catch (error) {
    writeBootLog(`Memory purge partially failed for ${id}: ${errorMessage(error)}`)
    return {
      ok: false as const,
      partial: true,
      error: `彻底清除未能完成全部存储层：${errorMessage(error)}。V4 中已执行的隐私清除不会自动恢复，请修复存储后重试。`,
    }
  }
  const residual = auditPurgedMemory(id, fact.id, originalContent)
  if ((await memory.list(localMemoryScope, 20_000)).some(item => item.id === id))
    residual.push('V3 当前索引仍含该记忆')
  if (memoryEmbeddingIndex?.hasMemory(id))
    residual.push('派生向量索引仍含该记忆')
  if (memoryV4EmbeddingIndex?.hasMemory(fact.id))
    residual.push('V4 派生语义索引仍含该记忆')
  if (memoryV4InternalFeedbackStore?.hasFact(fact.id) || memoryV4InternalFeedbackStore?.hasFact(id))
    residual.push('V4 Internal 反馈仍含该事实引用')
  if (residual.length > 0)
    return { ok: false as const, error: `清除后残留审计失败：${residual.join('；')}`, residual }
  writeBootLog(`Memory purge completed: ${id}, V3 removed=${removedV3}, V4 version=${lifecycle.version}, residual=0`)
  return {
    ok: true as const,
    count: await memory.count(localMemoryScope),
    report: {
      v3Removed: removedV3,
      v4FactId: fact.id,
      v4Version: lifecycle.version,
      purgedEpisodes: lifecycle.purgedEpisodes,
      invalidatedEvidence: lifecycle.invalidatedEvidence,
      invalidatedDerivedArtifacts: lifecycle.invalidatedDerivedArtifacts,
      residualCount: 0,
      checkpointCompacted: true,
      backupsScrubbed: true,
      embeddingIndexPurged: true,
      internalFeedbackPurged: true,
    },
  }
}

// ── IPC ─────────────────────────────────────────────────
async function migrateOpenL1() {
    if (!graphExtractionStore || !graphBasicRelations || !graphSemanticWorkflow || !apiConfig.apiKey.trim()) return { ok: false, error: '请先配置模型并开启记忆。' };
    const sourceKey = (r: GraphExtractionRun) => r.sourceId + ':' + r.sourceRevision;
    const completed = new Set(graphL1Store?.tasks().filter(t => t.state === 'published' && t.review.reviewer === 'user').map(t => sourceKey(t.run)) ?? []);
    const handled = new Set(graphSemanticWorkflow.list().filter(i => ['waiting', 'ready', 'published', 'dismissed', 'cancelled'].includes(i.status) && i.configFingerprint === createHash('sha256').update(JSON.stringify([GRAPH_SEMANTIC_WORKFLOW_VERSION, apiConfig.model, apiConfig.baseURL])).digest('hex')).map(i => sourceKey(i.run)));
    const candidates = [...new Map(graphExtractionStore.list().filter(r => r.status === 'complete' && !completed.has(sourceKey(r))
      && !handled.has(sourceKey(r)) && (r.factCandidates.length || r.assertionCandidates?.length)).map(r => [sourceKey(r), r])).values()]
      .filter(run => graphSemanticWorkflow!.canProcess(run));
    let processed = 0, skipped = 0;
    for (const original of candidates.slice(0, 5)) {
      const workflow = graphSemanticWorkflow;
      if (!workflow || !workflow.canProcess(original)) { skipped++; continue; }
      const extractor = createOpenGraphExtractor({ getConfig: () => ({ ...apiConfig }), complete: completeGraphSemanticJson,
        canSendSource: () => workflow === graphSemanticWorkflow && workflow.canProcess(original),
        saveGraphExtraction: run => saveGraphExtraction(run, true) });
      await extractor({ userMessage: original.sourceText, assistantMessage: '', metadata: { sourceMessageIds: [original.sourceId] } });
      processed++;
    }
    return { ok: true, processed, skipped, remaining: Math.max(0, candidates.length - processed - skipped) };
  }

let chatBusy = false
function setupIPC() {
  partitionIpc.handle('documents:list', () => documents.list())
  partitionIpc.handle('documents:pick', async () => {
    const result = await dialog.showOpenDialog({ title: '选择 PDF 或 Word 文档', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PDF / Word', extensions: ['pdf', 'docx'] }] })
    return result.canceled ? documents.list() : documents.importFiles(result.filePaths)
  })
  partitionIpc.handle('documents:preview', (_event, id: string) => documents.preview(id))
  partitionIpc.handle('documents:open', async (_event, id: string) => {
    const error = await shell.openPath(documents.path(id)); return error ? { ok: false, error } : { ok: true }
  })
  partitionIpc.handle('documents:location', (_event, id: string) => { shell.showItemInFolder(documents.path(id)); return { ok: true } })
  partitionIpc.handle('app:version', () => app.getVersion())

  partitionIpc.handle('chat:send', async (_event, message: string, attachments?: { type: 'image'; data: string; mimeType: string }[], selection?: { skillId?: string }) => {
    if (chatBusy) return { ok: false, error: '此对话正在生成回复，请稍候。' }
    if (!apiConfig.apiKey.trim())
      return { ok: false, error: '尚未配置 API Key，请点击右上角“API 设置”。' }
    chatBusy = true
    const internalReview = memoryV4InternalReview.begin(message)
    try {
      const selectedSkill = selection?.skillId ? skillService.load(selection.skillId, conversation.id) : undefined
      if (selectedSkill) sendPartitionEvent('skills:used', skillService.history(conversation.id))
      const result = await runtime.send(conversation.id, message, {
        ...(attachments?.length ? { attachments, input: { type: 'image' as const } } : {}),
        ...(selectedSkill ? { skill: { id: selectedSkill.id, payload: JSON.stringify(selectedSkill) } } : {}),
      })
      const memoryReview = await internalReview?.finish()
      return {
        ok: true,
        text: result.text,
        toolCalls: result.toolCalls,
        history: sessionStore.getSessionMessages(conversation.id),
        ...(memoryReview ? { memoryReview } : {}),
      }
    }
    catch (error) {
      await internalReview?.finish()
      writeBootLog(`chat request failed: ${errorMessage(error)}`)
      return { ok: false, error: errorMessage(error) }
    }
    finally {
      chatBusy = false
      saveSessions()
    }
  })

  partitionIpc.handle('memory:clarification-answer', async (_event, input: { id: string; candidateId: string; sourceRevision: string; text: string; contextSourceId?: string }) => {
    try {
      if (!graphSemanticWorkflow) return { ok: false, error: '澄清流程尚未就绪。' };
      const run = await graphSemanticWorkflow.answer(input.id, input.candidateId, input.sourceRevision, input.text, input.contextSourceId);
      if (run) {
        const reply = run.supplementalEvidence?.at(-1);
        if (reply) {
          const tasks = graphCaptureRepository?.register({ userMessage: reply.text, assistantMessage: '',
            metadata: { sessionId: conversation.id, sourceMessageIds: [reply.sourceId], clarificationFor: run.sourceId } }, localMemoryScope, 'clarification-evidence-v1') ?? [];
          for (const task of tasks) if (graphCaptureRepository?.claim(task.id)) graphCaptureRepository.finish(task.id, { candidateCount: 0, writtenCount: 0 });
          sessionStore.appendSessionMessage(conversation.id, { id: reply.sourceId, role: 'user', content: reply.text, createdAt: Date.now() });
          saveSessions();
        }
        await saveGraphExtraction(run);
      }
      sendPartitionEvent('memory:changed');
      return { ok: true };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      return { ok: false, error: code === 'stale-clarification' ? '原文或待澄清项已变化，请刷新后重试。'
        : code === 'invalid-clarification' ? '请选择可用的上下文，或填写不含敏感内容的补充说明。'
        : '模型尚未完成补充信息处理，说明已保留，可稍后重新提交。' };
    }
  });
  partitionIpc.handle('memory:clarification-dismiss', (_event, input: { id: string; candidateId: string }) => {
    try { graphSemanticWorkflow?.dismiss(input.id, input.candidateId); return { ok: true }; }
    catch { return { ok: false, error: '待澄清项已失效。' }; }
  });
  partitionIpc.handle('memory:relation-mapping-revoke', async (_event, id: string) => {
    if (!graphBasicRelations || typeof id !== 'string') return { ok: false };
    const affected = graphL1Store?.tasks().filter(t => t.run.factCandidates.some(f => f.mappingId === id)) ?? [];
    graphBasicRelations.revokeMapping(id);
    for (const task of affected) if (task.factRef && memoryV4Lifecycle) {
      memoryV4Lifecycle.deleteFact(task.factRef.id, localMemoryScope, 'suppress',
        { reason: '关系映射已撤销，等待独立关系重建', idempotencyKey: 'revoke-mapping:' + id + ':' + task.id });
    }
    graphL1Store?.retireClaims(affected.map(t => t.id));
    invalidateGraphL1Projection(); syncGraphSemantic();
    for (const task of affected) void saveGraphExtraction({ ...task.run, id: crypto.randomUUID() })
      .catch(() => { graphExtractionError = '映射撤销后的独立关系重建尚未完成'; });
    sendPartitionEvent('memory:changed');
    return { ok: true };
  });
  partitionIpc.handle('memory:open-l1-migrate', migrateOpenL1);
  partitionIpc.handle('memory:semantic-retry', async () => {
    const runs = await graphSemanticWorkflow?.retry(5) ?? [];
    for (const run of runs) await saveGraphExtraction(run);
    return { ok: true, processed: runs.length };
  });
  partitionIpc.handle('memory:clarifications-list', () => ({
    items: graphSemanticWorkflow?.list().filter(i => i.status === 'waiting').flatMap(i => i.decisions
      .filter(d => d.verdict === 'needs-context').map(d => ({ id: i.id, candidateId: d.candidateId,
        sourceId: i.run.sourceId, sourceRevision: i.run.sourceRevision, sourceText: i.run.sourceText,
        question: d.question, options: d.options, reason: d.reason }))) ?? [],
    contexts: graphCaptureRepository?.snapshot().sources.filter(s => s.status === 'active'
      && s.scope.ownerId === localMemoryScope.ownerId && s.scope.agentId === localMemoryScope.agentId
      && !!s.turn?.userMessage && s.turn.userMessage.length <= 4000
      && inferMemoryPrivacy(s.turn.userMessage).sensitivity === 'normal').slice(-50)
      .map(s => ({ id: s.messageIds[0] ?? s.id, text: s.turn!.userMessage.slice(0, 100) })) ?? [],
    failed: graphSemanticWorkflow?.list().filter(i => i.status === 'failed'
      || (i.status === 'ready' && i.decisions.some(d => d.verdict === 'supported'))).length ?? 0,
  }));
  partitionIpc.handle('screen:capture', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 1280, height: 720 },
      fetchWindowIcons: false,
    })
    if (sources.length === 0)
      return { ok: false, error: 'no sources' }
    // Use the first screen source
    const source = sources[0]!
    const thumbnail = source.thumbnail
    const dataUrl = thumbnail.toDataURL()
    // Parse data URL: data:image/jpeg;base64,xxxx
    const match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl)
    if (!match)
      return { ok: false, error: 'failed to encode thumbnail' }
    return { ok: true, data: match[2]!, mimeType: match[1]! }
  })

  partitionIpc.handle('settings:get', () => {
    return settingsMgr.get()
  })

  partitionIpc.handle('settings:set-name', async (_event, name: string) => {
    settingsMgr.setName(name)
    agentName = name
    currentPersona = buildPersona(name)
    rebuildRuntime()
    mainWindow?.setTitle(name)
    return { ok: true }
  })

  partitionIpc.handle('settings:set-theme', async (_event, theme: string) => {
    settingsMgr.setTheme(theme)
    return { ok: true }
  })

  partitionIpc.handle('api:get', () => ({
    configured: !!apiConfig.apiKey.trim(),
    baseURL: apiConfig.baseURL,
    model: apiConfig.model,
  }))

  partitionIpc.handle('api:set', async (_event, input: { apiKey?: string; baseURL?: string; model?: string }) => {
    const apiKey = input.apiKey?.trim() || apiConfig.apiKey
    const baseURL = input.baseURL?.trim() || ''
    const model = input.model?.trim() || ''

    if (!apiKey)
      return { ok: false, error: '请输入 API Key。' }
    if (!baseURL)
      return { ok: false, error: '请输入 API Base URL。' }
    try {
      const url = new URL(baseURL)
      if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new Error('unsupported protocol')
    }
    catch {
      return { ok: false, error: 'API Base URL 必须是有效的 HTTP 或 HTTPS 地址。' }
    }
    if (!model)
      return { ok: false, error: '请输入模型名称。' }

    await memory?.flushPendingCaptures()
    apiConfig = { apiKey, baseURL: baseURL.replace(/\/$/, ''), model }
    saveApiConfig()
    initializeMemory()
    rebuildRuntime()
    return { ok: true, configured: true }
  })

  partitionIpc.handle('sessions:history', () => {
    return sessionStore.getSessionMessages(conversation.id)
  })

  partitionIpc.handle('sessions:truncate-after', async (_event, messageId: string) => {
    const msgs = sessionStore.getSessionMessages(conversation.id)
    const idx = msgs.findIndex(m => m.id === messageId)
    if (idx < 0)
      return { ok: false, error: 'message not found' }
    const removedMessageIds = msgs.slice(idx).map(message => message.id)
    msgs.splice(idx)
    if (memory && removedMessageIds.length > 0)
      await memory.unlinkSources(removedMessageIds, localMemoryScope)
    saveSessions()
    return { ok: true }
  })

  partitionIpc.handle('memory:graph-diagnostics', () => {
    if (!memoryV4Repository) return { ok: false, error: 'V4 仓库尚未就绪。' }
    try {
      const report = diagnoseV4GraphInputs(memoryV4Repository, {
        scope: localMemoryScope, expectedRevision: memoryV4Repository.snapshot().revision, now: Date.now(),
        authorizeScope: scope => scope.ownerId === localMemoryScope.ownerId
          && scope.agentId === localMemoryScope.agentId && scope.sessionId === undefined,
        canRead: record => memorySettings.remotePolicy !== 'disabled' && record.sharePolicy === 'allow-remote'
          && (record.sensitivity === 'normal'
            || (record.sensitivity === 'private' && memorySettings.remotePolicy === 'allow-private')),
      })
      return { ok: true, graphEnabled: graphMemoryEnabled, pendingWrites: memoryV4Shadow?.pendingCount() ?? 0, report }
    } catch {
      return { ok: false, error: '诊断未完成：数据可能已更新、不符合结构校验或超过扫描上限，请刷新后重试。' }
    }
  })

  partitionIpc.handle('memory:status', async () => ({
    graphClaimCount: graphL1Store?.claims().length ?? 0,
    capture: memory?.captureStatus(),
    enabled: !!memory,
    count: memory ? await memory.count(localMemoryScope) : 0,
    storagePath: memoryStoragePath,
    encrypted: !!memory,
    error: memoryInitializationError,
    legacyMigrated: memoryLegacyMigrated,
    v4: {
      enabled: !!memoryV4Shadow,
      storagePath: memoryV4StoragePath,
      pendingWrites: memoryV4Shadow?.pendingCount() ?? 0,
      journalPendingEntries: memoryV4Persistence?.pendingEntries() ?? 0,
      reconciliation: memoryV4Reconciliation,
      error: memoryV4Error,
      killSwitchEnabled: !config.memoryV4ShadowEnabled,
      audit: memoryV4Audit,
      shadowRead: {
        index: memoryV4ShadowWorkerClient?.status().lastIndex,
        worker: memoryV4ShadowWorkerClient?.status(),
        currentSession: memoryV4ShadowComparator.status(),
        persistentEvaluation: memoryV4ShadowEvaluationStore?.status(),
        queue: memoryV4ShadowTaskQueue?.status(),
        rolloutGate: evaluateMemoryV4RolloutGate(),
        evaluationStoragePath: memoryV4ShadowEvaluationPersistence?.encryptedPath,
        evaluationError: memoryV4ShadowEvaluationError,
        authoritativeAnswerSource: memoryV4ReadController?.status().last?.authoritativeReadSource ?? 'v3',
        configuredReadMode: config.memoryV4ReadMode,
        officialRead: memoryV4ReadController?.status(),
        runtimeObservability: {
          reportPath: memoryV4RuntimeReportPath,
          report: memoryV4RuntimeObservability.status(),
        },
        rolloutStage: effectiveMemoryV4RolloutStage(),
        requestedRolloutStage: memorySettings.v4RolloutStage,
        rolloutStageLocked: memoryV4InternalReviewEnvironmentOverride !== undefined,
        internalReview: memoryV4InternalReview.status(),
        internalFeedback: memoryV4InternalFeedbackStore?.status(),
        internalFeedbackCalibration: memoryV4InternalFeedbackCalibrationStatus(),
        internalFeedbackPath: memoryV4InternalFeedbackPath,
        internalFeedbackError: memoryV4InternalFeedbackError,
        learnedSemantic: memoryV4SemanticBackgroundIndex && memoryV4Repository
          ? memoryV4SemanticBackgroundIndex.status(memoryV4Repository.snapshot())
          : undefined,
        learnedSemanticPath: memoryV4EmbeddingStoragePath,
        learnedSemanticError: memoryV4SemanticError,
      },
    },
    settings: memorySettings,
    semantic: {
      installed: semanticMemory.isInstalled(),
      active: memorySettings.semanticEnabled && semanticMemory.isVerified(),
      model: SEMANTIC_MEMORY_MODEL,
      progress: semanticModelProgress,
      integrity: semanticMemory.integrity(),
      cachePath: semanticMemory.cacheDir,
      indexPath: memoryEmbeddingStoragePath,
      index: memoryStore?.embeddingStatus(SEMANTIC_MEMORY_FINGERPRINT, localMemoryScope),
    },
    ocr: { progress: imageMemoryProgress, cachePath: imageMemory.cachePath },
  }))

  partitionIpc.handle('memory:list', async (_event, limit = 200) => {
    const openAssertions = graphCaptureRepository && graphExtractionStore
      ? projectOpenAssertions(graphCaptureRepository.snapshot(), graphExtractionStore, localMemoryScope) : []
    const openCandidateKeys = new Set(openAssertions.map(item => `${item.extraction.runId}\0${item.extraction.candidateId}`))
    const registry = currentGraphPredicateRegistry()
    for (const run of graphExtractionStore?.list() ?? [])
      for (const fact of run.factCandidates)
        if (needsOpenFactRepresentation(run, fact, registry)) openCandidateKeys.add(`${run.id}\0${fact.id}`)
    return ({
    capture: memory?.captureStatus(),
    ok: true,
    enabled: !!memory,
    count: memory ? await memory.count(localMemoryScope) : 0,
    storagePath: memoryStoragePath,
    encrypted: !!memory,
    error: memoryInitializationError,
    v4: {
      enabled: !!memoryV4Shadow,
      storagePath: memoryV4StoragePath,
      pendingWrites: memoryV4Shadow?.pendingCount() ?? 0,
      journalPendingEntries: memoryV4Persistence?.pendingEntries() ?? 0,
      reconciliation: memoryV4Reconciliation,
      error: memoryV4Error,
      killSwitchEnabled: !config.memoryV4ShadowEnabled,
      audit: memoryV4Audit,
      shadowRead: {
        index: memoryV4ShadowWorkerClient?.status().lastIndex,
        worker: memoryV4ShadowWorkerClient?.status(),
        currentSession: memoryV4ShadowComparator.status(),
        persistentEvaluation: memoryV4ShadowEvaluationStore?.status(),
        queue: memoryV4ShadowTaskQueue?.status(),
        rolloutGate: evaluateMemoryV4RolloutGate(),
        evaluationStoragePath: memoryV4ShadowEvaluationPersistence?.encryptedPath,
        evaluationError: memoryV4ShadowEvaluationError,
        authoritativeAnswerSource: memoryV4ReadController?.status().last?.authoritativeReadSource ?? 'v3',
        configuredReadMode: config.memoryV4ReadMode,
        officialRead: memoryV4ReadController?.status(),
        runtimeObservability: {
          reportPath: memoryV4RuntimeReportPath,
          report: memoryV4RuntimeObservability.status(),
        },
        rolloutStage: effectiveMemoryV4RolloutStage(),
        requestedRolloutStage: memorySettings.v4RolloutStage,
        rolloutStageLocked: memoryV4InternalReviewEnvironmentOverride !== undefined,
        internalReview: memoryV4InternalReview.status(),
        internalFeedback: memoryV4InternalFeedbackStore?.status(),
        internalFeedbackCalibration: memoryV4InternalFeedbackCalibrationStatus(),
        internalFeedbackPath: memoryV4InternalFeedbackPath,
        internalFeedbackError: memoryV4InternalFeedbackError,
        learnedSemantic: memoryV4SemanticBackgroundIndex && memoryV4Repository
          ? memoryV4SemanticBackgroundIndex.status(memoryV4Repository.snapshot())
          : undefined,
        learnedSemanticPath: memoryV4EmbeddingStoragePath,
        learnedSemanticError: memoryV4SemanticError,
      },
    },
    settings: memorySettings,
    semantic: {
      installed: semanticMemory.isInstalled(),
      active: memorySettings.semanticEnabled && semanticMemory.isVerified(),
      model: SEMANTIC_MEMORY_MODEL,
      progress: semanticModelProgress,
      integrity: semanticMemory.integrity(),
      indexPath: memoryEmbeddingStoragePath,
      index: memoryStore?.embeddingStatus(SEMANTIC_MEMORY_FINGERPRINT, localMemoryScope),
    },
    items: memory ? await memory.list(localMemoryScope, Number(limit)) : [],
    reviewItems: memoryCandidateReview?.list(localMemoryScope, Number(limit)) ?? [],
    graphL1View: (() => {
      const view = graphL1ProjectionRepository?.snapshot()
      return view ? { manifestId: view.manifest.manifestId, bundleId: view.manifest.sourceBundleId,
        claims: view.semanticBundle.claims.length, information: view.semanticBundle.information?.length ?? 0,
        openAssertions: view.semanticBundle.openAssertions?.filter(canNavigateOpenAssertion).length ?? 0,
        argumentEdges: view.edges.length } : null
    })(),
    graphInformationItems: (graphL1ProjectionRepository?.snapshot()?.semanticBundle.information ?? [])
      .slice().sort((a, b) => b.recordedAt - a.recordedAt).slice(0, 20)
      .map(item => ({ id: item.ref.id, text: item.content.slice(0, 500), recordedAt: item.recordedAt,
        sourceId: item.source.captureId })),
    graphOpenAssertionItems: openAssertions.filter(item => item.review.status !== 'rejected')
      .sort((a, b) => Number(a.review.status === 'accepted') - Number(b.review.status === 'accepted')).slice(0, Number(limit)),
    graphClaimItems: (graphL1Store?.claims() ?? []).slice().reverse().slice(0, 100).map(claim => {
      const task = graphL1Store?.tasks().find(task => task.id === claim.ref.id)
      const registration = currentGraphPredicateRegistry().registrations.find(r => r.spec.name === claim.atom.predicate)
      return { id: claim.ref.id, relation: claim.sourceStatement?.relationText
          ?? registration?.labels.find(label => /[\p{Script=Han}]/u.test(label.text))?.text ?? claim.atom.predicate,
        arguments: Object.entries(claim.atom.args).map(([role, term]) => ({ role,
          text: term.kind === 'entity' ? task?.entities.find(entity => entity.ref.id === term.ref.id)?.canonicalName ?? term.ref.id : JSON.stringify(term) })),
        polarity: claim.polarity, modality: claim.modality, time: claim.temporalSource.value ?? '未指定',
        sourceText: task?.run.sourceText ?? '', supplementalEvidence: task?.run.supplementalEvidence ?? [] }
    }),
    graphExtraction: {
      enabled: !!graphExtractionStore && isGraphExtractionEnabled(memorySettings),
      modelReady: memorySettings.extractionMode === 'open' || memorySettings.extractionMode === 'smart'
        ? !!apiConfig.apiKey.trim() && !!apiConfig.model.trim() && memorySettings.remotePolicy !== 'disabled'
        : localUie.isReady(),
      error: graphExtractionError || null,
      runs: graphExtractionStore?.list().length ?? 0,
      factCandidates: graphExtractionStore?.list().reduce((count, run) => count + run.factCandidates.length + (run.assertionCandidates?.length ?? 0), 0) ?? 0,
      sourcesWithoutFacts: graphSourcesWithoutFactCandidates(graphExtractionStore?.list() ?? []).length,
      pendingReviews: (graphL1Store?.reviews().filter(item => item.status === 'pending'
        && !openCandidateKeys.has(`${item.runId}\0${item.sourceFactId}`)).length ?? 0),
      automaticOpenNavigation: openAssertions.filter(item => item.review.status === 'candidate' && canNavigateOpenAssertion(item)).length,
      deferredOpenCandidates: openAssertions.filter(item => item.review.status === 'candidate' && !canNavigateOpenAssertion(item)).length,
      claims: graphL1Store?.claims().length ?? 0,
      basicClaims: graphL1Store?.claims().filter(claim => !!claim.sourceStatement).length ?? 0,
      basicRelations: graphBasicRelations?.definitions().length ?? 0,
    },
    clarifications: graphSemanticWorkflow?.list().filter(item => item.status === 'waiting').flatMap(item => item.decisions.filter(d => d.verdict === 'needs-context').map(d => ({ id: item.id, candidateId: d.candidateId, sourceId: item.run.sourceId, sourceRevision: item.run.sourceRevision, sourceText: item.run.sourceText, question: d.question, options: d.options, reason: d.reason }))) ?? [],
    semanticWorkflow: graphSemanticWorkflow?.list().reduce((stats, item) => { stats[item.status] = (stats[item.status] ?? 0) + 1; return stats }, {} as Record<string, number>) ?? {},
    relationMappings: graphBasicRelations?.mappings().map(mapping => {
      const definitions = graphBasicRelations!.definitions();
      const target = currentGraphPredicateRegistry().registrations.find(r => r.spec.name === mapping.targetId);
      return { ...mapping, sourceText: definitions.find(d => d.registration.spec.name === mapping.sourceId)?.relationText ?? mapping.sourceId,
        targetText: definitions.find(d => d.registration.spec.name === mapping.targetId)?.relationText
          ?? target?.labels.find(l => /[\p{Script=Han}]/u.test(l.text))?.text ?? mapping.targetId };
    }) ?? [],
    graphReviewItems: graphL1Store?.reviews().filter(item => item.status === 'pending'
      && !openCandidateKeys.has(`${item.runId}\0${item.sourceFactId}`))
      .slice(0, Number(limit)).map((review) => {
      const run = graphExtractionStore?.list().find(item => item.id === review.runId)
      const source = run?.factCandidates.find(item => item.id === review.sourceFactId)
      const normalized = graphNormalizationStore?.results().find(item => item.runId === review.runId)
      const mentionIds = source ? [source.subjectMentionId, ...('mentionId' in source.object ? [source.object.mentionId] : [])] : []
      return {
        review,
        predicate: source?.predicate ?? '',
        subject: run?.entityMentions.find(item => item.id === source?.subjectMentionId)?.text ?? '',
        object: (source && ('literal' in source.object ? source.object.literal
          : run?.entityMentions.find(item => 'mentionId' in source.object && item.id === source.object.mentionId)?.text)) ?? '',
        sourceText: run?.sourceText ?? '',
        privacyOrigin: run?.modelId === 'uie-base' && review.sensitivity === 'private'
          && inferMemoryPrivacy(run.sourceText).sensitivity === 'normal' ? 'uie-default-local' : 'content-policy',
        evidence: run && source ? run.sourceText.slice(source.evidenceSpan.start, source.evidenceSpan.end) : '',
        context: source?.context,
        mentions: mentionIds.map(id => {
          const mention = run?.entityMentions.find(item => item.id === id)
          const resolution = normalized?.resolutions.find(item => item.mentionId === id)
          return { id, text: mention?.text ?? '', type: mention?.type ?? '',
            resolvedEntityId: resolution?.status === 'resolved' ? resolution.entityId : undefined,
            options: graphNormalizationStore?.entities().filter(entity => entity.entityType === mention?.type
              && entity.scope.ownerId === localMemoryScope.ownerId && entity.scope.agentId === localMemoryScope.agentId
              && entity.scope.sessionId === undefined && entity.review?.status !== 'rejected')
              .map(entity => ({ id: entity.ref.id, name: entity.canonicalName })) ?? [] }
        }),
      }
    }) ?? [],
    graphRelationReviewItems: graphRelationTaskQueue?.snapshot().filter(task => task.status === 'completed'
      && (!task.review || task.review.status === 'pending')).slice(0, Number(limit)).map(task => {
      const claims = task.claims.map(ref => graphL1ProjectionRepository?.snapshot()?.semanticBundle.claims.find(claim =>
        claim.ref.id === ref.id && claim.ref.version === ref.version))
      return { key: task.key, claims: task.claims, routes: task.routes, result: task.result,
        modelId: task.modelId, modelRevision: task.modelRevision, review: task.review,
        evidence: claims.map(claim => claim ? graphClaimEvidenceText(claim) : ''),
        sensitivity: claims.some(claim => claim?.sensitivity === 'secret') ? 'secret'
          : claims.some(claim => claim?.sensitivity === 'private') ? 'private' : 'normal' }
    }) ?? [],
    graphL2View: (() => {
      const view = graphL1ProjectionRepository?.snapshot()
      const l2 = graphRelationRepository?.snapshot()
      return view && l2?.manifest.state === 'ready' && l2.manifest.coreManifestId === view.manifest.manifestId
        ? { manifestId: l2.manifest.manifestId, candidates: l2.candidates.length,
          relations: l2.relations.filter(item => item.transactionTime.closedAt === null).length }
        : null
    })(),
    graphL2Candidates: (() => {
      const view = graphL1ProjectionRepository?.snapshot()
      const l2 = graphRelationRepository?.snapshot()
      if (!view || !l2 || l2.manifest.state !== 'ready'
        || l2.manifest.coreManifestId !== view.manifest.manifestId) return []
      return l2.candidates.filter(item => item.resolution.status === 'pending'
        && (item.kind === 'entails' || item.kind === 'contradicts'))
        .slice(0, Number(limit)).map(candidate => {
          const from = view.semanticBundle.claims.find(claim => claim.ref.id === candidate.from.id
            && claim.ref.version === candidate.from.version)
          const to = view.semanticBundle.claims.find(claim => claim.ref.id === candidate.to.id
            && claim.ref.version === candidate.to.version)
          const observations = l2.observations.filter(item => item.candidateId === candidate.id)
          return { id: candidate.id, kind: candidate.kind, from: candidate.from, to: candidate.to,
            fromEvidence: from ? graphClaimEvidenceText(from) : '',
            toEvidence: to ? graphClaimEvidenceText(to) : '',
            context: candidate.context, observations: observations.map(item => ({
              predicted: item.predicted, scores: item.scores, truncated: item.truncated,
              modelId: item.modelId, modelRevision: item.modelRevision })),
            sensitivity: from?.sensitivity === 'secret' || to?.sensitivity === 'secret' ? 'secret'
              : from?.sensitivity === 'private' || to?.sensitivity === 'private' ? 'private' : 'normal' }
        })
    })(),
    pendingCaptureSegments: memory?.pendingCaptureCount() ?? 0,
    })
  })

  partitionIpc.handle('memory:candidate-review', async (
    _event,
    input: { id?: unknown; outcome?: unknown; note?: unknown },
  ) => {
    if (!memory || !memoryCandidateReview)
      return { ok: false, error: 'V4 候选审核当前不可用。' }
    const id = typeof input?.id === 'string' ? input.id.trim() : ''
    const note = typeof input?.note === 'string' ? input.note.trim() : undefined
    if (!id || (input.outcome !== 'approved' && input.outcome !== 'rejected'))
      return { ok: false, error: '无效的候选审核操作。' }
    const changed = input.outcome === 'approved'
      ? await memoryCandidateReview.approve(id, localMemoryScope, async target => {
          await memory!.remember(target.content, target.scope, target.metadata)
        }, note)
      : memoryCandidateReview.reject(id, localMemoryScope, note)
    memoryV4Shadow?.flush()
    return changed ? { ok: true } : { ok: false, error: '候选不存在、已审核或不属于当前作用域。' }
  })

  partitionIpc.handle('memory:graph-review', async (
    _event,
    input: { id?: unknown; outcome?: unknown; reason?: unknown; retrievalRetain?: unknown; proactivePreference?: unknown;
      context?: unknown; identities?: unknown; sourceRevision?: unknown },
  ) => {
    if (!graphL1Store || !graphL1Writer || !graphExtractionStore || !graphNormalizationStore)
      return { ok: false, error: 'Graph L1 审核当前不可用。' }
    const id = typeof input?.id === 'string' ? input.id.trim() : ''
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : ''
    if (!id || !reason || !['approved', 'rejected', 'pending'].includes(String(input.outcome)))
      return { ok: false, error: '无效的 Graph L1 审核操作。' }
    const current = graphL1Store.reviews().find(item => item.id === id)
    if (!current || graphL1Store.tasks().some(task => task.review.id === id))
      return { ok: false, error: '审核项不存在或已进入发布流程。' }
    if (current.status !== 'pending') return { ok: false, error: '此候选已审核。' }
    if (input.outcome === 'approved') {
      if (!input.context || typeof input.context !== 'object' || !input.identities
        || typeof input.identities !== 'object' || Array.isArray(input.identities))
        return { ok: false, error: '确认入图前必须审核实体身份和语境。' }
    }
    let review = input.outcome === 'approved' ? confirmGraphClaim(current, reason)
      : input.outcome === 'rejected' ? rejectGraphClaim(current, reason)
        : deferGraphClaim(current, reason)
    if (review.status === 'approved'
      && (typeof input.retrievalRetain === 'boolean' || typeof input.proactivePreference === 'boolean')) {
      review = setGraphUseAssessment(review, {
        retrievalRetain: typeof input.retrievalRetain === 'boolean' ? input.retrievalRetain : review.retrieval.retain,
        proactivePreference: typeof input.proactivePreference === 'boolean'
          ? input.proactivePreference : review.proactive.useAsPreference,
        reason,
      })
    }
    if (review.status !== 'approved') {
      graphL1Store.recordReview(review)
      return { ok: true }
    }
    const run = graphExtractionStore.list().find(item => item.id === review.runId)
    let fact = graphNormalizationStore.results().find(item => item.runId === review.runId)
      ?.facts.find(item => item.sourceFactId === review.sourceFactId)
    if (!run || !fact)
      return { ok: false, error: '来源或抽取结果不可用。' }
    try {
      if (input.sourceRevision !== run.sourceRevision || review.sourceRevision !== run.sourceRevision)
        throw new Error('来源版本已变化，请刷新审核列表')
      const identities = input.identities as Record<string, unknown>
      if (Object.values(identities).some(value => typeof value !== 'string'))
        throw new Error('实体身份选择无效')
      const admission = reviewGraphAdmission(run, review.sourceFactId,
        input.context as GraphAdmissionChoices, identities as Record<string, string>)
      const confirmed = confirmGraphFactIdentities(run, review.sourceFactId, {
        entities: graphNormalizationStore.entities(), aliases: graphNormalizationStore.aliasDecisions(),
        scope: localMemoryScope, choicesByMentionId: admission.identities,
      })
      fact = confirmed.normalized.facts.find(item => item.sourceFactId === review.sourceFactId)
      if (!fact || fact.status !== 'ready') throw new Error('来源或实体身份尚未完成解析')
      graphNormalizationStore.replaceCatalog(confirmed.entities, graphNormalizationStore.aliasDecisions())
      graphNormalizationStore.appendResult(confirmed.normalized)
      const task = await graphL1Writer.submit(run, fact, review, confirmed.entities, admission)
      return task?.state === 'published' ? { ok: true, published: true } : { ok: true, published: false }
    }
    catch (error) { return { ok: false, error: errorMessage(error) } }
  })

  partitionIpc.handle('memory:graph-open-review', async (_event,
    input: { id?: unknown; sourceRevision?: unknown; outcome?: unknown; reason?: unknown }) => {
    if (!graphCaptureRepository || !graphExtractionStore || !graphSemanticRepository || !graphL1Store || !memoryV4Repository)
      return { ok: false, error: '图存储不可用。' }
    if (typeof input?.id !== 'string' || typeof input.reason !== 'string' || !input.reason.trim()
      || input.reason.length > 500 || !['accepted', 'rejected'].includes(String(input.outcome)))
      return { ok: false, error: '请填写有效的审核决定与原因。' }
    const assertion = projectOpenAssertions(graphCaptureRepository.snapshot(), graphExtractionStore, localMemoryScope)
      .find(item => item.ref.id === input.id)
    if (!assertion || assertion.review.status === 'rejected'
      || (assertion.review.status === 'accepted' && input.outcome !== 'rejected') || assertion.extraction.sourceRevision !== input.sourceRevision)
      return { ok: false, error: '候选或来源版本已变化，请刷新。' }
    try {
      graphExtractionStore.recordOpenReview({ assertionId: assertion.ref.id, sourceId: assertion.extraction.sourceId,
        sourceRevision: assertion.extraction.sourceRevision,
        status: input.outcome as 'accepted' | 'rejected', reason: input.reason.trim(), reviewedAt: Date.now() })
      invalidateGraphL1Projection()
      const synced = await graphSemanticRepository.syncFromClaims(graphL1Store, memoryV4Repository, currentGraphPredicateRegistry(), localMemoryScope)
      if (!synced.ok || !graphL1ProjectionRepository?.sync()) throw new Error('图视图尚未就绪，请刷新后重试。')
      syncGraphRelationTasks()
      return { ok: true }
    } catch (error) { return { ok: false, error: errorMessage(error) } }
  })

  partitionIpc.handle('memory:graph-open-search', async (_event, input: { query?: unknown; maximumDepth?: unknown; includeCandidates?: unknown }) => {
    if (typeof input?.query !== 'string' || !input.query.trim() || input.query.length > 500)
      return { ok: false, error: '请输入查询内容。' }
    const view = graphL1ProjectionRepository?.snapshot()
    if (!view) return { ok: false, error: '图视图尚未就绪，请刷新。' }
    const needle = input.query.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, '')
    const results = await searchOpenAssertionsWithContext(view.semanticBundle, input.query,
      { scope: localMemoryScope, maximumDepth: typeof input.maximumDepth === 'number' ? input.maximumDepth : 1, limit: 20,
        includeCandidates: input.includeCandidates === true,
        ...(memorySettings.semanticEnabled && semanticMemory.isVerified() ? { embed: embedOpenContext } : {}) })
    // Async embeddings must not reveal a removed source or an out-of-date review.
    if (graphL1ProjectionRepository?.snapshot()?.manifest.manifestId !== view.manifest.manifestId)
      return { ok: false, error: '查询期间来源或审核状态已变化，请重新查询。' }
    return { ok: true, ...results,
      sources: (view.semanticBundle.information ?? []).filter(item => item.content.normalize('NFKC').toLocaleLowerCase()
        .replace(/\s+/gu, '').includes(needle)).slice(0, 20).map(item => ({ id: item.ref.id, text: item.content })) }
  })

  partitionIpc.handle('memory:graph-custom-extract', async (_event, input: { sourceId?: unknown; targets?: unknown }) => {
    if (!graphCaptureRepository || !graphExtractionStore || !localUie.isReady()) return { ok: false, error: '本地 UIE 或图存储不可用。' }
    if (typeof input?.sourceId !== 'string' || typeof input.targets !== 'string' || !input.targets.trim() || input.targets.length > 2000)
      return { ok: false, error: '请输入抽取目标，例如：样品→存放位置；设备→故障。' }
    const source = graphCaptureRepository.snapshot().sources.find(item => item.id === input.sourceId && item.status === 'active')
    if (!source?.turn || source.scope.ownerId !== localMemoryScope.ownerId || source.scope.agentId !== localMemoryScope.agentId)
      return { ok: false, error: '原文来源不可用。' }
    const store = graphExtractionStore
    try {
      const schema = parseUieExtractionTargets(input.targets)
      const extraction = await localUie.extract(source.turn.userMessage, schema)
      if (store !== graphExtractionStore || !graphCaptureRepository.snapshot().sources.some(item => item.id === source.id
        && item.status === 'active' && item.revision === source.revision && item.contentHash === source.contentHash))
        throw new Error('提取期间来源已变化，请刷新。')
      await saveGraphExtraction(uieGraphExtractionRun(source.messageIds[0] ?? source.id, source.turn.userMessage, extraction))
      return { ok: true }
    } catch (error) { return { ok: false, error: errorMessage(error) } }
  })

  partitionIpc.handle('memory:graph-relation-review', async (_event,
    input: { key?: unknown; outcome?: unknown; reason?: unknown }) => {
    const key = typeof input?.key === 'string' ? input.key.trim() : ''
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : ''
    if (!graphRelationTaskQueue || !key || !reason || !['accepted', 'rejected', 'pending'].includes(String(input.outcome)))
      return { ok: false, error: '无效的信息关系审核操作。' }
    const changed = graphRelationTaskQueue.review(key, input.outcome as 'accepted' | 'rejected' | 'pending', reason)
    if (changed) await queueGraphL2Sync()
    return changed ? { ok: true } : { ok: false, error: '候选不存在或 NLI 判断尚未完成。' }
  })

  partitionIpc.handle('memory:graph-l2-publish', async (_event,
    input: { candidateId?: unknown; reason?: unknown }) => {
    const candidateId = typeof input?.candidateId === 'string' ? input.candidateId.trim() : ''
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : ''
    if (!candidateId || !reason || reason.length > 500)
      return { ok: false, error: '请指定候选并填写核实关系语义的原因。' }
    try {
      const generation = graphL2Generation
      return await queueGraphL2Work(async () => {
        await syncGraphL2Once(generation)
        const core = graphL1ProjectionRepository?.snapshot()
        if (generation !== graphL2Generation || !core || !graphRelationRepository)
          return { ok: false, error: '稳定的 L1/L2 图视图尚未就绪。' }
        const result = await publishReviewedGraphRelation({ repository: graphRelationRepository,
          core, candidateId, reason, reviewer: 'local-user', evidenceText: graphClaimEvidenceText })
        if (!result.ok) return { ok: false, error: result.error.message }
        syncGraphRelationTasks()
        return { ok: true, relation: result.value.relationRef }
      })
    }
    catch (error) { return { ok: false, error: errorMessage(error) } }
  })

  partitionIpc.handle('memory:v4-internal-feedback', async (
    _event,
    input: { reviewId?: unknown; factId?: unknown; label?: unknown },
  ) => {
    if (!memoryV4InternalFeedbackStore)
      return { ok: false, error: 'V4 Internal 反馈存储当前不可用。' }
    const reviewId = typeof input?.reviewId === 'string' ? input.reviewId.trim() : ''
    const factId = typeof input?.factId === 'string' ? input.factId.trim() : ''
    if (!reviewId || !isMemoryV4InternalFeedbackLabel(input?.label))
      return { ok: false, error: '无效的 V4 Internal 反馈。' }
    const result = memoryV4InternalFeedbackStore.recordFeedback({
      reviewId,
      ...(factId ? { factId } : {}),
      label: input.label,
    })
    if (!result.ok) {
      const errors = {
        'unknown-review': '评审记录已过期或不存在。',
        'unknown-candidate': '候选不属于该评审。',
        'invalid-target': '“遗漏/无需记忆”只能标记整轮评审，其他反馈必须选择具体候选；“无需记忆”不能与“正确”候选并存。',
      }
      return { ok: false, error: errors[result.reason] }
    }
    try {
      memoryV4InternalFeedbackStore.flush()
      return { ok: true, label: result.label, status: memoryV4InternalFeedbackStore.status() }
    }
    catch (error) {
      memoryV4InternalFeedbackError = errorMessage(error)
      return { ok: false, error: `反馈未能加密保存：${memoryV4InternalFeedbackError}` }
    }
  })

  partitionIpc.handle('memory:candidate-reprocess', async (
    _event,
    input: { cursor?: unknown; batchSize?: unknown } = {},
  ) => {
    if (!memoryCandidateReview || !memoryStore)
      return { ok: false, error: 'V4 候选重处理当前不可用。' }
    const calibrationDataset = memoryCandidateReview.calibrationDataset(localMemoryScope)
    const calibrator = fitIsotonicMemoryConfidenceCalibrator(calibrationDataset.examples, {
      versionLabel: 'quarantine-review-shadow-v1',
    })
    const report = await memoryCandidateReview.reprocess({
      scope: localMemoryScope,
      verifier: createLocalMemoryCandidateVerifier({ calibrator }),
      inspectMatches: memoryStore.inspectWriteMatches,
      batchSize: typeof input.batchSize === 'number' ? input.batchSize : 100,
      ...(typeof input.cursor === 'string' && input.cursor.trim() ? { cursor: input.cursor.trim() } : {}),
      shadow: true,
    })
    return {
      ok: true,
      report: {
        ...report,
        calibration: {
          source: calibrationDataset.source,
          suitableForProductionCalibration: calibrationDataset.suitableForProductionCalibration,
          sampleCount: calibrationDataset.reviewedCount,
          approvedCount: calibrationDataset.approvedCount,
          rejectedCount: calibrationDataset.rejectedCount,
          calibratorVersion: calibrator.version,
        },
      },
    }
  })

  partitionIpc.handle('memory:capture-flush', async () => {
    if (!memory)
      return { ok: false, error: '长期记忆已关闭。' }
    await memory.flushPendingCaptures()
    memoryV4Shadow?.flush()
    return { ok: true, pendingCaptureSegments: memory.pendingCaptureCount() }
  })

  partitionIpc.handle('memory:capture-retry', async () => {
    if (!memory) return { ok: false, error: '长期记忆已关闭。' }
    try {
      await memory.resumePendingCaptures(true)
      return { ok: true, capture: memory.captureStatus() }
    }
    catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  })

  partitionIpc.handle('memory:add', async (_event, content: string) => {
    if (!memory)
      return { ok: false, error: '长期记忆已关闭。' }
    const normalized = typeof content === 'string' ? content.trim() : ''
    if (!isSafeMemoryContent(normalized))
      return { ok: false, error: '内容为空，或包含指令注入、密钥、密码等不安全信息。' }
    const privacy = inferMemoryPrivacy(normalized)
    await memory.remember(normalized, localMemoryScope, {
      kind: 'manual',
      importance: 1,
      confidence: 1,
      origin: 'manual',
      ...privacy,
      source: 'memory-manager',
    })
    return { ok: true, count: await memory.count(localMemoryScope) }
  })

  partitionIpc.handle('memory:forget', async (_event, id: string) => {
    if (!memory)
      return { ok: false, error: '长期记忆已关闭。' }
    if (typeof id !== 'string' || !id.trim())
      return { ok: false, error: '无效的记忆 ID。' }
    await memory.forget(id, localMemoryScope)
    return { ok: true, count: await memory.count(localMemoryScope) }
  })

  partitionIpc.handle('memory:purge-prepare', async (_event, id: string) => prepareMemoryPurge(id))

  partitionIpc.handle('memory:purge-confirm', async (_event, input: { id?: unknown; token?: unknown; phrase?: unknown }) => confirmMemoryPurge(input))

  partitionIpc.handle('memory:update', async (_event, id: string, patch: Record<string, unknown>) => {
    if (!memory)
      return { ok: false, error: '长期记忆已关闭。' }
    if (typeof id !== 'string' || !id.trim() || !patch || typeof patch !== 'object')
      return { ok: false, error: '无效的记忆更新。' }
    const allowed: Record<string, unknown> = {}
    if (typeof patch.content === 'string') {
      const content = patch.content.trim()
      if (!isSafeMemoryContent(content))
        return { ok: false, error: '编辑后的内容为空，或包含指令注入、密钥、密码等不安全信息。' }
      allowed.content = content
    }
    if (typeof patch.importance === 'number')
      allowed.importance = patch.importance
    if (patch.expiresAt === null || typeof patch.expiresAt === 'number')
      allowed.expiresAt = patch.expiresAt
    if (patch.sharePolicy === 'allow-remote' || patch.sharePolicy === 'local-only' || patch.sharePolicy === 'ask')
      allowed.sharePolicy = patch.sharePolicy
    if (patch.sensitivity === 'normal' || patch.sensitivity === 'private' || patch.sensitivity === 'secret')
      allowed.sensitivity = patch.sensitivity
    if (patch.status === 'active' || patch.status === 'superseded' || patch.status === 'expired'
      || patch.status === 'conflicted' || patch.status === 'orphaned'
      || patch.status === 'suppressed' || patch.status === 'deleted')
      allowed.status = patch.status
    const updated = await memory.update(id, localMemoryScope, allowed)
    return updated ? { ok: true } : { ok: false, error: '没有找到该记忆。' }
  })

  partitionIpc.handle('memory:restore', async (_event, id: string) => {
    if (!memory)
      return { ok: false, error: '长期记忆已关闭。' }
    const restored = typeof id === 'string' && await memory.restore(id, localMemoryScope)
    return restored ? { ok: true } : { ok: false, error: '没有找到该记忆。' }
  })

  partitionIpc.handle('memory:settings-set', async (_event, input: Partial<MemorySettings>) => {
    await memory?.flushPendingCaptures()
    const nextSettings = normalizeMemorySettings({ ...memorySettings, ...input })
    const requestedRolloutStage = input.v4RolloutStage === undefined
      ? nextSettings.v4RolloutStage
      : normalizeMemoryV4RolloutStage(input.v4RolloutStage, { defaultStage: memorySettings.v4RolloutStage })
    const rolloutTransition = checkMemoryV4RolloutTransition({
      currentStage: memorySettings.v4RolloutStage,
      requestedStage: requestedRolloutStage,
      ...(memoryV4InternalReviewEnvironmentOverride === undefined
        ? {}
        : { environmentOverride: memoryV4InternalReviewEnvironmentOverride ? 'internal' : 'shadow' }),
      shadowAvailable: !!memoryV4Shadow,
      workerAvailable: !!memoryV4ShadowWorkerClient,
    })
    if (!rolloutTransition.ok && rolloutTransition.reason === 'environment-locked') {
      return {
        ok: false,
        error: 'V4 阶段由 CONTINUUM_MEMORY_V4_INTERNAL_REVIEW（或兼容的 DESKPET_MEMORY_V4_INTERNAL_REVIEW）环境变量锁定，无法在界面修改。',
        settings: memorySettings,
      }
    }
    if (!rolloutTransition.ok && rolloutTransition.reason === 'runtime-unavailable') {
      return {
        ok: false,
        error: 'V4 影子存储或隔离召回 Worker 不可用，不能进入 Internal 阶段。',
        settings: memorySettings,
      }
    }
    if (nextSettings.semanticEnabled && !semanticMemory.isInstalled()) {
      return { ok: false, error: '请先下载本地语义模型。', settings: memorySettings }
    }
    if (nextSettings.semanticEnabled && !semanticMemory.isVerified() && !await semanticMemory.verify()) {
      return {
        ok: false,
        error: semanticMemory.integrity().error ?? '本地语义模型完整性校验失败，请重新安装。',
        settings: memorySettings,
      }
    }
    if (nextSettings.semanticEnabled && !memorySettings.semanticEnabled)
      await prepareSemanticMemoryIndex()
    memorySettings = nextSettings
    saveMemorySettings()
    initializeMemory()
    rebuildRuntime()
    return { ok: true, settings: memorySettings }
  })

  let graphReextractBusy = false
  partitionIpc.handle('memory:graph-reextract-empty', async () => {
    if (graphReextractBusy) return { ok: false, error: '正在重新提取，请稍候。' }
    const useOpen = memorySettings.extractionMode === 'open' || memorySettings.extractionMode === 'smart'
    if (!graphExtractionStore || !graphNormalizationStore || !graphL1Store
      || (useOpen ? !apiConfig.apiKey.trim() || !apiConfig.model.trim() || memorySettings.remotePolicy === 'disabled' : !localUie.isReady()))
      return { ok: false, error: '当前提取模型、发送权限或图存储不可用。' }
    if (!isGraphExtractionEnabled(memorySettings))
      return { ok: false, error: '请先开启保存 UIE 图提取结果。' }
    const store = graphExtractionStore
    const sources = graphSourcesWithoutFactCandidates(store.list()).slice(0, 5)
    let processed = 0, candidates = 0
    graphReextractBusy = true
    try {
      for (const source of sources) {
        if (useOpen) {
          if (!isSafeMemoryContent(source.sourceText) || inferMemoryPrivacy(source.sourceText).sensitivity !== 'normal')
            continue // Historical private sources are not authorized by selecting an extraction mode.
          let extractionFailure: string | undefined
          let saved = false
          const extractor = createOpenGraphExtractor({ getConfig: () => ({ ...apiConfig }),
            saveGraphExtraction: async run => {
              if (graphExtractionStore !== store || !store.list().some(item => item.id === source.id)) {
                extractionFailure = '记忆来源或设置已变化，请刷新后重试。'
                throw new Error(extractionFailure)
              }
              await saveGraphExtraction(run)
              saved = true
              if (run.status === 'failed') extractionFailure = '开放提取失败，请检查 API 配置。'
              candidates += run.assertionCandidates?.length ?? 0
            } })
          await extractor({ userMessage: source.sourceText, assistantMessage: '',
            metadata: { sourceMessageIds: [source.sourceId] } })
          if (extractionFailure || !saved) throw new Error(extractionFailure ?? '开放提取未保存，请检查配置与图存储。')
          processed++
          continue
        }
        const extraction = await localUie.extract(source.sourceText, planUieSchema(source.sourceText).schema)
        // Settings reload, clear, or source deletion while the model is running
        // must not restore removed material into a new store.
        if (graphExtractionStore !== store || !store.list().some(run => run.id === source.id))
          throw new Error('记忆来源或设置已变化，请刷新后重试。')
        if (!graphSourcesWithoutFactCandidates(store.list()).some(run => run.id === source.id)) continue
        const run = uieGraphExtractionRun(source.sourceId, source.sourceText, extraction)
        await saveGraphExtraction(run)
        processed++
        candidates += run.factCandidates.length
      }
      graphExtractionError = ''
      return { ok: true, processed, candidates,
        remaining: graphSourcesWithoutFactCandidates(store.list()).length }
    }
    catch (error) {
      graphExtractionError = errorMessage(error)
      return { ok: false, error: graphExtractionError, processed, candidates }
    }
    finally { graphReextractBusy = false }
  })

  let graphAutoReassessBusy = false
  partitionIpc.handle('memory:graph-auto-reassess', async () => {
    if (graphAutoReassessBusy) return { ok: false, error: '图事实正在自动重审，请稍候。' }
    if (!graphCaptureRepository || !graphExtractionStore || !graphNormalizationStore || !graphL1Store || !graphL1Writer)
      return { ok: false, error: '图事实审核存储当前不可用。' }
    graphAutoReassessBusy = true
    try {
      const result = await reassessRetainedUieGraphFacts({
        extractions: graphExtractionStore, normalization: graphNormalizationStore,
        l1: graphL1Store, writer: graphL1Writer,
        captureSnapshot: () => graphCaptureRepository!.snapshot(), scope: localMemoryScope,
      })
      return { ok: true, ...result }
    }
    finally { graphAutoReassessBusy = false }
  })

  partitionIpc.handle('memory:uie-extract', async (_event, text: unknown) => {
    if (typeof text !== 'string' || !text.trim() || text.length > 4000)
      return { ok: false, error: '请输入不超过 4000 字的文本。' }
    try {
      const extraction = await localUie.extract(text)
      const graph = uieGraphExtractionRun('local-preview', text, extraction)
      return { ok: true, extraction,
        graphPreview: { status: graph.status, entityMentions: graph.entityMentions,
          factCandidates: graph.factCandidates } }
    }
    catch (error) {
      return { ok: false, error: `本地 UIE-base 提取失败：${errorMessage(error)}` }
    }
  })

  partitionIpc.handle('memory:model-install', async () => {
    try {
      await memory?.flushPendingCaptures()
      await semanticMemory.install()
      await prepareSemanticMemoryIndex()
      memorySettings.semanticEnabled = true
      saveMemorySettings()
      initializeMemory()
      rebuildRuntime()
      return { ok: true, settings: memorySettings }
    }
    catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  })

  partitionIpc.handle('memory:clear', async () => {
    if (!memory)
      return { ok: false, error: '长期记忆已关闭。' }
    invalidateMemoryV4ShadowComparisons()
    await memory.clear(localMemoryScope)
    graphExtractionStore?.clear()
    graphNormalizationStore?.clear()
    graphL1Store?.clear()
    graphBasicRelations?.clear()
    graphSemanticWorkflow?.clear()
    invalidateGraphL1Projection()
    syncGraphSemantic()
    memoryV4ShadowEvaluationStore?.clear()
    memoryV4InternalFeedbackStore?.clear()
    return { ok: true, count: 0 }
  })

  partitionIpc.handle('memory:open-location', async () => {
    if (existsSync(memoryStoragePath)) {
      shell.showItemInFolder(memoryStoragePath)
      return { ok: true }
    }
    const error = await shell.openPath(userDataDir)
    return error ? { ok: false, error } : { ok: true }
  })

  partitionIpc.handle('app:reset', async () => {
    invalidateMemoryV4ShadowComparisons()
    await memory?.clear(localMemoryScope)
    graphExtractionStore?.clear()
    graphNormalizationStore?.clear()
    graphL1Store?.clear()
    graphBasicRelations?.clear()
    graphSemanticWorkflow?.clear()
    invalidateGraphL1Projection()
    syncGraphSemantic()
    memoryV4ShadowEvaluationStore?.clear()
    sessionStore.getSessionMessages(conversation.id).splice(0)
    saveSessions()
    rootPersist.saveJson('settings', { agentName: null, firstRunAt: null })
    persist.saveAllImmediately()
    app.relaunch()
    app.quit()
  })
}


  setupIPC()
  return {
    handlers,
    async start() {
      if (config.memoryEnabled && memorySettings.semanticEnabled && semanticMemory.isInstalled()) {
        const verified = await semanticMemory.verify()
        if (!verified) writeBootLog(`semantic startup verification failed: ${semanticMemory.integrity().error ?? 'unknown error'}`)
      }
      initializeMemory()
      rebuildRuntime()
    },
    activate() { rebuildRuntime() },
    async shutdown() {
  if (graphNliRetryTimer) clearTimeout(graphNliRetryTimer)
  graphNliJudge?.close()
  memoryV4ConsolidationRunner?.stop()
  memoryV4ShadowGeneration += 1
  memoryV4ShadowTaskQueue?.stop()
  memoryV4ShadowWorkerClient?.stop()
  try {
    memoryV4EmbeddingIndex?.compact()
  }
  catch (error) {
    writeBootLog(`Memory V4 learned semantic index final compact failed: ${errorMessage(error)}`)
  }
  try {
    memoryV4ShadowEvaluationStore?.flush()
  }
  catch (error) {
    writeBootLog(`Memory V4 shadow evaluation final flush failed: ${errorMessage(error)}`)
  }
  try {
    memoryV4InternalFeedbackStore?.flush()
  }
  catch (error) {
    writeBootLog(`Memory V4 Internal feedback final flush failed: ${errorMessage(error)}`)
  }
  await memory?.flushPendingCaptures().catch(error => writeBootLog(`Partition capture shutdown failed: ${String(error)}`))
  try {
    memoryV4Shadow?.flush()
  }
  catch (error) {
    writeBootLog(`Memory V4 shadow final flush failed: ${errorMessage(error)}`)
  }
  saveSessions()
  persist.saveAllImmediately()
  localUie.dispose()
    },
    async smoke() {

        if (memoryV4ReadController) {
          const recalled = await memoryV4ReadController.recallAdaptive('我叫什么名字？', localMemoryScope, {
            maxInjected: 3,
            sharePolicies: ['allow-remote'],
            sensitivities: ['normal'],
          })
          const status = memoryV4ReadController.status()
          writeBootLog(`Memory V4 official read smoke completed: mode ${status.configuredMode}, source ${status.last?.authoritativeReadSource ?? 'none'}, fallback ${status.last?.fallbackReason ?? 'none'}, memories ${recalled.injectedMemoryIds.length}`)
        }
        else {
          writeBootLog('Memory V4 official read smoke skipped: controller unavailable')
        }
        if (memoryV4ShadowWorkerClient) {
          const result = await memoryV4ShadowWorkerClient.recall('我叫什么名字？', {
            scope: localMemoryScope,
            limit: 3,
            sharePolicies: ['allow-remote'],
            sensitivities: ['normal'],
          })
          writeBootLog(`Memory V4 worker smoke completed: revision ${result.snapshotRevision}, ${result.hits.length} hits`)
        }
        else {
          writeBootLog('Memory V4 worker smoke skipped: shadow runtime unavailable')
        }
        const expectedRolloutStage = environmentValue('CONTINUUM_MEMORY_SMOKE_EXPECT_ROLLOUT_STAGE', 'DESKPET_SMOKE_EXPECT_ROLLOUT_STAGE')?.trim()
        if (expectedRolloutStage) {
          const actualRolloutStage = effectiveMemoryV4RolloutStage()
          if (expectedRolloutStage !== actualRolloutStage)
            throw new Error(`Expected V4 rollout stage ${expectedRolloutStage}, received ${actualRolloutStage}`)
          writeBootLog(`Memory V4 rollout smoke verified: ${actualRolloutStage}, read mode ${config.memoryV4ReadMode}`)
        }
        const purgeId = environmentValue('CONTINUUM_MEMORY_SMOKE_PURGE_ID', 'DESKPET_SMOKE_PURGE_ID')?.trim()
        if (purgeId) {
          const prepared = await prepareMemoryPurge(purgeId)
          if (!prepared.ok)
            throw new Error(prepared.error)
          const result = await confirmMemoryPurge({ id: purgeId, token: prepared.token, phrase: prepared.phrase })
          if (!result.ok)
            throw new Error(result.error)
          writeBootLog(`smoke purge report: ${JSON.stringify(result.report)}`)
        }
        writeBootLog('smoke test completed')
        setTimeout(() => app.quit(), 100)

    },
  }
}

async function getPartition(id: string): Promise<ConversationPartition> {
  const conversation = conversationRegistry.get(id)
  sessionStore.ensureSession(id)
  sessionsCache[id] = sessionStore.getSessionMessages(id)
  let pending = partitions.get(id)
  if (!pending) {
    pending = (async () => {
      const partition = createConversationPartition(conversation, conversationRegistry.directory(id, rootUserDataDir))
      await partition.start()
      return partition
    })()
    partitions.set(id, pending)
    pending.catch(() => { if (partitions.get(id) === pending) partitions.delete(id) })
  }
  return pending
}
function setupConversationIPC() {
  for (const channel of activePartition.handlers.keys()) ipcMain.handle(channel, async (event, ...args) => {
    const envelope = args.at(-1)
    const id = envelope && typeof envelope === 'object' && typeof envelope.conversationId === 'string'
      ? (args.pop(), envelope.conversationId) : conversationRegistry.active().id
    const partition = await getPartition(id)
    return partition.handlers.get(channel)!(event, ...args)
  })
  const snapshot = () => ({ activeId: conversationRegistry.active().id, conversations: conversationRegistry.list() })
  ipcMain.handle('conversations:list', snapshot)
  let switching = false
  const select = async (create: boolean, value: unknown) => {
    if (switching) return { ok: false, error: '正在切换对话，请稍候。' }
    switching = true
    try {
      const previousId = conversationRegistry.active().id
      const entry = create ? conversationRegistry.create(typeof value === 'string' ? value : '新对话')
        : conversationRegistry.get(String(value))
      sessionStore.ensureSession(entry.id)
      sessionsCache[entry.id] = sessionStore.getSessionMessages(entry.id)
      saveSessions()
      try { activePartition = await getPartition(entry.id) }
      catch (error) { conversationRegistry.select(previousId); throw error }
      conversationRegistry.select(entry.id)
      activePartition.activate()
      return { ok: true, ...snapshot(), history: sessionStore.getSessionMessages(entry.id) }
    } catch (error) { return { ok: false, error: errorMessage(error) } }
    finally { switching = false }
  }
  ipcMain.handle('conversations:create', (_event, title) => select(true, title))
  ipcMain.handle('conversations:select', (_event, id) => select(false, id))
  ipcMain.handle('conversations:rename', (_event, id, title) => {
    conversationRegistry.rename(id, title)
    return { ok: true, ...snapshot() }
  })
  ipcMain.handle('skills:list', () => skillService.list())
  ipcMain.handle('skills:refresh', () => skillService.scan())
  ipcMain.handle('skills:set-enabled', (_event, id, enabled) => skillService.setEnabled(id, enabled))
  ipcMain.handle('skills:history', (_event, id) => skillService.history(conversationRegistry.get(id).id))
  ipcMain.handle('skills:preview', (_event, id) => skillService.preview(id))
  ipcMain.handle('skills:add-directory', async () => {
    const result = await dialog.showOpenDialog({ title: '选择包含 SKILL.md 的目录', properties: ['openDirectory'] })
    return result.canceled ? skillService.list() : skillService.addRoot(result.filePaths[0]!)
  })
  setupVoiceIPC()
}

// ── Window ──────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    minWidth: 600,
    minHeight: 400,
    title: agentName,
    backgroundColor: '#0f1117',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  })

  mainWindow.webContents.on('did-finish-load', () => {
    writeBootLog('renderer finished loading')
    // Deterministic, API-free packaged/startup smoke test. It is inactive in
    // normal launches and lets CI/debug runs verify the renderer plus memory
    // initialization without leaving Electron processes behind.
    if (environmentValue('CONTINUUM_MEMORY_SMOKE_TEST', 'DESKPET_SMOKE_TEST') === 'true') {
      void activePartition.smoke().catch((error) => {
        writeBootLog(`smoke test failed: ${errorMessage(error)}`)
        app.exit(2)
      })
    }
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    writeBootLog(`renderer failed to load: ${code} ${description}`)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    writeBootLog(`renderer process gone: ${details.reason} (${details.exitCode})`)
  })
  mainWindow.once('ready-to-show', () => writeBootLog('window ready to show'))

  if (process.env.ELECTRON_RENDERER_URL)
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else
    mainWindow.loadFile(join(moduleDir, '../renderer/index.html'))
}

// ── App lifecycle ──────────────────────────────────────
app.whenReady().then(async () => {
  apiConfig = loadApiConfig()
  initializeSessions()
  const skillPersistence = safeStorage.isEncryptionAvailable() ? createEncryptedFilePersistence({
    encryptedPath: join(userDataDir, 'skills-state.enc'), keyPath: join(userDataDir, 'skills-state-key.json'),
    protectKey: key => safeStorage.encryptString(key.toString('base64')),
    unprotectKey: key => Buffer.from(safeStorage.decryptString(key), 'base64'),
  }) : { load: () => undefined, save: (_payload: string) => {} }
  const codexRoot = process.env.CODEX_HOME || join(process.env.USERPROFILE ?? '', '.codex')
  const skillRoots = process.env.CONTINUUM_MEMORY_SKILL_ROOTS?.split(';').filter(Boolean)
    ?? [join(codexRoot, 'skills'), ...['openai-bundled', 'openai-curated', 'openai-curated-remote', 'openai-primary-runtime']
      .map(group => join(codexRoot, 'plugins', 'cache', group))]
  const dependencyRoot = join(process.env.USERPROFILE ?? '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies')
  documentRuntime = await probeDocumentRuntime({
    pythonPath: process.env.CONTINUUM_MEMORY_DOCUMENT_PYTHON || join(dependencyRoot, 'python', 'python.exe'),
    scriptPath: app.isPackaged ? join(process.resourcesPath, 'document_tools.py') : join(app.getAppPath(), 'resources', 'document_tools.py'),
    popplerPath: process.env.CONTINUUM_MEMORY_PDF_RENDERER || join(dependencyRoot, 'native', 'poppler', 'Library', 'bin', 'pdftoppm.exe'),
  })
  skillService = createDesktopSkillService({ roots: skillRoots, persistence: skillPersistence, documentCapabilities: documentRuntime })
  const registryPersistence = safeStorage.isEncryptionAvailable() ? createEncryptedFilePersistence({
    encryptedPath: join(userDataDir, 'conversations.enc'), keyPath: join(userDataDir, 'conversations-key.json'),
    protectKey: key => safeStorage.encryptString(key.toString('base64')),
    unprotectKey: key => Buffer.from(safeStorage.decryptString(key), 'base64'),
  }) : { load: () => undefined, save: (_payload: string) => {} }
  conversationRegistry = createConversationRegistry({ persistence: registryPersistence, legacySessionIds: Object.keys(sessionsCache) })
  activePartition = await getPartition(conversationRegistry.active().id)
  setupConversationIPC()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0)
      createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin')
    app.quit()
})

let partitionShutdown: Promise<void> | undefined
let partitionShutdownComplete = false
app.on('before-quit', event => {
  if (partitionShutdownComplete) return
  event.preventDefault()
  if (partitionShutdown) return
  partitionShutdown = (async () => {
    const outcomes = await Promise.allSettled([...partitions.values()].map(async entry => (await entry).shutdown()))
    for (const outcome of outcomes) if (outcome.status === 'rejected') writeBootLog(`Partition shutdown failed: ${String(outcome.reason)}`)
    saveSessions()
    rootPersist.saveAllImmediately()
    sharedLocalUie.dispose()
    for (const model of sharedNliModels.values()) model.close()
    await graphLocalSelection.dispose()
  })().finally(() => { partitionShutdownComplete = true; app.quit() })
})
