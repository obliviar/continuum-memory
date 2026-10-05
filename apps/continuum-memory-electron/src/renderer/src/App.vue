<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted, computed, watch, provide } from 'vue'
import { graphReviewIpcFields, graphReviewTimeError } from '../../shared/graph-review-ipc'
import type { GraphOpenAssertionRecord } from '@continuum-memory/memory'
import GraphOpenAssertions from './components/GraphOpenAssertions.vue'
import MemoryRecallNotice from './components/MemoryRecallNotice.vue'
import MemoryMark from './components/MemoryMark.vue'
import { APP_ICON_THEME } from './app-icon'
import AppIcon from './components/AppIcon.vue'
import SkillPicker from './components/SkillPicker.vue'
import SendArtwork from './components/SendArtwork.vue'
import MessageMarkdown from './components/MessageMarkdown.vue'
import ConversationSearch from './components/ConversationSearch.vue'
import ConversationDelete from './components/ConversationDelete.vue'
import QuickPhrases from './components/QuickPhrases.vue'
import GeneralSettings from './components/GeneralSettings.vue'
import ComposerEditor from './components/ComposerEditor.vue'
import SavedMessages from './components/SavedMessages.vue'
import MemoryActivity from './components/MemoryActivity.vue'
import { DEFAULT_CHAT_PREFERENCES, shortcutFromEvent, type ChatPreferences } from '../../shared/chat-preferences'
import { bookmarkKey, type MessageBookmarkView } from '../../shared/chat-bookmarks'
import type { MemoryActivityReport } from '../../shared/memory-activity'
import type { EditorSelection } from '../../shared/chat-ui'
import { useChatDrafts } from './chat-drafts'
import type { ConversationListItem, ConversationSearchResult, MessageQuote, QuickPhrase } from '../../shared/chat-ui'
import { themes, resolveTheme, type Theme } from './themes'

import { activeConversationId, ipcRenderer } from './conversation-ipc'
import { dialogFocus as vDialogFocus } from './dialog-focus'

interface Message {
  role: 'user' | 'assistant'
  content: string
  id: string
  hasImage?: boolean
  quote?: MessageQuote
  status?: 'failed' | 'stopped'
  replyTo?: string
  persisted?: boolean
  retryImage?: { data: string; mimeType: string }
  memoryReview?: MemoryV4InternalCandidateReview
}

interface MemoryV4InternalCandidateReview {
  reviewId: string
  mode: 'internal-candidate'
  authoritativeAnswerSource: 'v3'
  v4InfluencedAnswer: false
  queryIntent: string
  v3: { retrievedCount: number; injectedCount: number }
  v4: {
    abstained: boolean
    bestEvidenceScore: number
    threshold: number
    calibrationVersion: string
    candidates: Array<{
      factId: string
      content: string
      score: number
      routes: string[]
      status: string
      verificationState: string
    }>
  }
  agreement: { overlapCount: number; recallAtK: number; precisionAtK: number; jaccard: number }
}

type MemoryV4InternalFeedbackLabel =
  | 'correct'
  | 'should-not-use'
  | 'incorrect'
  | 'expired'
  | 'missing'
  | 'no-memory'
  | 'privacy'

const V4_INTERNAL_CANDIDATE_FEEDBACK_OPTIONS: Array<{
  label: Exclude<MemoryV4InternalFeedbackLabel, 'missing'>
  text: string
}> = [
  { label: 'correct', text: '正确' },
  { label: 'should-not-use', text: '不应使用' },
  { label: 'incorrect', text: '事实错误' },
  { label: 'expired', text: '已过期' },
  { label: 'privacy', text: '隐私不当' },
]

interface MemoryItem {
  id: string
  content: string
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt?: number
  status?: 'active' | 'superseded' | 'expired' | 'conflicted' | 'orphaned' | 'suppressed' | 'deleted'
  origin?: 'automatic' | 'manual' | 'image'
  importance?: number
  confidence?: number
  accessCount?: number
  lastAccessedAt?: number
  expiresAt?: number
  sharePolicy?: 'allow-remote' | 'local-only' | 'ask'
  sensitivity?: 'normal' | 'private' | 'secret'
  sourceMessageIds?: string[]
  sourceAttachmentIds?: string[]
}

interface MemorySettings {
  extractionMode: 'rules' | 'smart' | 'uie' | 'open'
  uieSupplementEnabled: boolean
  graphExtractionEnabled: boolean
  openSourceRecallEnabled: boolean
  semanticEnabled: boolean
  imageMemoryEnabled: boolean
  remotePolicy: 'normal-only' | 'allow-private' | 'disabled'
  v4RolloutStage: 'shadow' | 'internal'
}

interface MemoryReviewItem {
  candidate: {
    id: string
    canonicalText: string
    predicate: string
    verificationScore?: number
    evidenceScore?: number
    calibratedActiveProbability?: number
    calibrationLowerBound?: number
    calibrationStatus?: 'calibrated' | 'insufficient-data' | 'out-of-distribution'
    durabilityScore: number
    ambiguityFlags: string[]
    decisionReasonCodes?: string[]
    createdAt: number
  }
  evidence: Array<{ id: string; content?: string; contentState: string; recordedAt: number }>
}

interface GraphReviewItem {
  review: {
    id: string
    status: 'pending'
    reason: string
    modelScore: number
    sourceId: string
    sourceRevision: string
    sensitivity: 'normal' | 'private' | 'secret'
    retrieval: { retain: boolean; reason: string }
    proactive: { useAsPreference: boolean; reason: string }
  }
  predicate: string
  evidence: string
  subject: string
  object: string
  sourceText: string
  privacyOrigin?: 'uie-default-local' | 'content-policy'
  context?: { negation: { value: boolean | null; resolution: string }; condition: { value: string | null; resolution: string };
    time: { value: string | null; resolution: string }; speaker: { value: string | null; resolution: string } }
  mentions: Array<{ id: string; text: string; type: string; resolvedEntityId?: string;
    options: Array<{ id: string; name: string }> }>
}

interface GraphRelationReviewItem {
  key: string
  claims: Array<{ id: string; version: number }>
  routes: string[]
  result: { label: 'CONTRADICTION' | 'NEUTRAL' | 'ENTAILMENT'; scores?: Record<string, number>; truncated?: boolean }
  evidence: string[]
  sensitivity: string
  review?: { status: string; reason: string }
}
interface GraphL2CandidateItem {
  id: string
  kind: 'entails' | 'contradicts'
  from: { id: string; version: number }
  to: { id: string; version: number }
  fromEvidence: string
  toEvidence: string
  observations: Array<{ predicted: string; scores: Record<string, number>; truncated: boolean;
    modelId: string; modelRevision: string }>
  sensitivity: string
}

// ── Speech synthesis types (Chromium built-in TTS) ─────
// (speechSynthesis and SpeechSynthesisUtterance are global DOM types)

const CUSTOM_THEME_PREFIX = 'custom:'
const DEFAULT_CUSTOM_COLOR = '#7c5ce7'

function parseHexColor(value: string): { r: number; g: number; b: number } | null {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim())
  if (!match) return null
  const hex = match[1]!
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  }
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map(channel => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, '0'))
    .join('')}`
}

function mixHex(color: string, target: string, targetWeight: number): string {
  const sourceRgb = parseHexColor(color)!
  const targetRgb = parseHexColor(target)!
  return rgbToHex(
    sourceRgb.r * (1 - targetWeight) + targetRgb.r * targetWeight,
    sourceRgb.g * (1 - targetWeight) + targetRgb.g * targetWeight,
    sourceRgb.b * (1 - targetWeight) + targetRgb.b * targetWeight,
  )
}

function relativeLuminance(color: string): number {
  const rgb = parseHexColor(color)!
  const channels = [rgb.r, rgb.g, rgb.b].map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
}

function ensureWhiteTextContrast(color: string): string {
  let result = color
  while (1.05 / (relativeLuminance(result) + 0.05) < 4.5)
    result = mixHex(result, '#000000', 0.12)
  return result
}

function createCustomTheme(color: string): Theme {
  const normalized = parseHexColor(color) ? color.toLowerCase() : DEFAULT_CUSTOM_COLOR
  const accent = ensureWhiteTextContrast(normalized)
  const accentRgb = parseHexColor(accent)!
  return {
    id: 'custom',
    name: '自定义颜色',
    bg: mixHex(normalized, '#ffffff', 0.82),
    surface: mixHex(normalized, '#ffffff', 0.95),
    surfaceHover: mixHex(normalized, '#ffffff', 0.88),
    border: mixHex(normalized, '#ffffff', 0.64),
    text: '#1f2937',
    textMuted: '#64748b',
    accent,
    accentHover: mixHex(accent, '#000000', 0.12),
    accentSoft: `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},0.14)`,
    scrollThumb: mixHex(normalized, '#ffffff', 0.52),
  }
}

// ── State ───────────────────────────────────────────────
const agentName = ref('Continuum Memory')
const appVersion = ref('')
const isFirstRun = ref(true)
const loaded = ref(false)
const nameInput = ref('')
const messages = ref<Message[]>([])
const conversations = ref<ConversationListItem[]>([])
const selectedConversationId = ref('default')
const conversationSwitching = ref(false)
const conversationError = ref('')
const renamingConversation = ref(false)
const conversationRenameInput = ref('')
const conversationMessages = new Map<string, Message[]>()
const pendingConversations = new Set<string>()
const conversationImages = new Map<string, { data: string; mimeType: string } | null>()
const memoryDrafts = new Map<string, { manual: string; preview: string; editingId: string | null; editingContent: string; replies: Record<string, string> }>()
const currentConversationTitle = computed(() => conversations.value.find(c => c.id === activeConversationId.value)?.title ?? '当前对话')
const canSwitchConversation = computed(() => !conversationSwitching.value && !memoryMutating.value && !memoryLoading.value && !apiSaving.value && !isListening.value && !clarificationBusy.value && !semanticInstalling.value && !documentsBusy.value)
const input = ref('')
const composerTextarea = ref<HTMLTextAreaElement | null>(null)
function resizeComposer() {
  nextTick(() => {
    const textarea = composerTextarea.value
    if (!textarea) return
    // Measure without a scrollbar: its width can wrap even an empty placeholder.
    textarea.style.overflowY = 'hidden'
    textarea.style.height = '0px'
    const style = getComputedStyle(textarea)
    const minHeight = parseFloat(style.minHeight) || 40
    const borderHeight = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0)
    const maxHeight = Math.max(minHeight, Math.min(144, Math.floor(window.innerHeight * 0.20)))
    // Leave two pixels for fractional line heights at non-integer zoom levels.
    const lineHeight = parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    const naturalHeight = Math.ceil(Math.max(textarea.scrollHeight, lineHeight) + borderHeight + 2)
    textarea.style.height = `${Math.min(maxHeight, Math.max(minHeight, naturalHeight))}px`
    textarea.style.overflowY = textarea.scrollHeight > textarea.clientHeight + 1 ? 'auto' : 'hidden'
  })
}
watch(input, resizeComposer)
let composerWidth = -1
const composerResizeObserver = new ResizeObserver(entries => {
  const width = entries[0]?.contentRect.width
  // Observe width after layout; resizing the height must not trigger a loop.
  if (width !== undefined && Math.abs(width - composerWidth) > 0.5) {
    composerWidth = width
    resizeComposer()
  }
})
watch(composerTextarea, textarea => {
  composerResizeObserver.disconnect()
  composerWidth = -1
  if (textarea) composerResizeObserver.observe(textarea)
})
const isLoading = ref(false)
const chatEl = ref<HTMLElement | null>(null)
const currentTheme = ref<Theme>(themes[0]!)
const windowVisible = ref(!document.hidden)
provide(APP_ICON_THEME, computed(() => currentTheme.value.id))
watch(currentTheme, resizeComposer)
const showThemeMenu = ref(false)
const showAppMenu = ref(false)
const compactComposer = ref(window.innerWidth < 420)
function updateCompactComposer() { compactComposer.value = window.innerWidth < 420; resizeComposer() }
const customColor = ref(DEFAULT_CUSTOM_COLOR)
let themePreviewOrigin: Theme | null = null

// API settings state
const showApiSettings = ref(false)
const apiConfigured = ref(false)
const apiKeyInput = ref('')
const apiBaseURL = ref('https://api.openai.com/v1')
const apiModel = ref('gpt-4o-mini')
const apiSaving = ref(false)
const apiStatusMessage = ref('')
const apiStatusError = ref(false)
const apiDraftLoaded = ref(false)
interface DesktopSkill { id: string; name: string; description: string; source: 'builtin' | 'local'; path?: string;
  available: boolean; enabled: boolean; requirements: string[]; reason: string; version: string; replacementId?: string }
const showSkillManager = ref(false)
const showDocumentManager = ref(false)
const documentsBusy = ref(false)
const documentItems = ref<{ id: string; name: string; format: string; kind: string; validated?: boolean }[]>([])
const documentRuntime = ref<{ pdf: boolean; word: boolean; pdfPreview?: boolean; error?: string } | null>(null)
const documentMessage = ref('')
const documentPreview = ref<{ id?: string; name?: string; format: string; images?: string[]; notice?: string;
  blocks?: { type: string; text?: string; rows?: string[][] }[] } | null>(null)
function applyDocuments(result: { items: typeof documentItems.value; runtime: typeof documentRuntime.value }) {
  documentItems.value = result.items
  documentRuntime.value = result.runtime
}
async function refreshDocuments() {
  const id = activeConversationId.value
  const result = await ipcRenderer.invoke('documents:list')
  if (id === activeConversationId.value) applyDocuments(result)
}
async function openDocumentManager() {
  showDocumentManager.value = true
  try { await refreshDocuments() } catch (error) { documentMessage.value = error instanceof Error ? error.message : String(error) }
}
function closeDocumentManager() { if (!documentsBusy.value) showDocumentManager.value = false }
async function pickDocuments() {
  documentsBusy.value = true
  documentMessage.value = ''
  try { applyDocuments(await ipcRenderer.invoke('documents:pick')); showDocumentManager.value = true }
  catch (error) { documentMessage.value = error instanceof Error ? error.message : String(error); showDocumentManager.value = true }
  finally { documentsBusy.value = false }
}
async function inspectDocument(id: string) {
  documentsBusy.value = true
  try { documentPreview.value = await ipcRenderer.invoke('documents:preview', id); documentMessage.value = '' }
  catch (error) { documentMessage.value = error instanceof Error ? error.message : String(error) }
  finally { documentsBusy.value = false }
}
async function openDocument(id: string, location = false) {
  try { const result = await ipcRenderer.invoke(location ? 'documents:location' : 'documents:open', id); if (!result.ok) documentMessage.value = result.error }
  catch (error) { documentMessage.value = error instanceof Error ? error.message : String(error) }
}
function onDocumentsChanged(_event: unknown, result: { items: typeof documentItems.value; runtime: typeof documentRuntime.value }, origin?: { conversationId: string }) {
  if (!origin || origin.conversationId === activeConversationId.value) applyDocuments(result)
}
const skillsBusy = ref(false)
const skillItems = ref<DesktopSkill[]>([])
const skillWarnings = ref<string[]>([])
const skillQuery = ref('')
const skillStatusMessage = ref('')
const skillPreview = ref<{ id: string; instructions: string; truncated: boolean } | null>(null)
const selectedSkillId = ref('')
const skillUseHistory = ref<{ id: string; name: string; at: number; mode: string }[]>([])
const enabledSkills = computed(() => skillItems.value.filter(item => item.available && item.enabled))
const filteredSkills = computed(() => skillItems.value.filter(item => !skillQuery.value.trim()
  || `${item.name} ${item.description} ${item.reason}`.toLocaleLowerCase().includes(skillQuery.value.toLocaleLowerCase().trim())))
function applySkills(result: { items: DesktopSkill[]; warnings: string[] }) {
  skillItems.value = result.items
  skillWarnings.value = result.warnings
  if (selectedSkillId.value && !enabledSkills.value.some(skill => skill.id === selectedSkillId.value)) selectedSkillId.value = ''
}
async function refreshSkills() {
  applySkills(await ipcRenderer.invoke('skills:list'))
  const id = activeConversationId.value
  const events = await ipcRenderer.invoke('skills:history', id)
  if (id === activeConversationId.value) skillUseHistory.value = events
}
async function openSkillManager() {
  showSkillManager.value = true
  skillStatusMessage.value = ''
  try { await refreshSkills() } catch (error) { skillStatusMessage.value = error instanceof Error ? error.message : String(error) }
}
function closeSkillManager() { if (!skillsBusy.value) showSkillManager.value = false }
async function changeSkill(id: string, enabled: boolean) {
  if (skillsBusy.value) return
  skillsBusy.value = true
  try { applySkills(await ipcRenderer.invoke('skills:set-enabled', id, enabled)); skillStatusMessage.value = 'Skill 状态已保存。' }
  catch (error) { skillStatusMessage.value = error instanceof Error ? error.message : String(error) }
  finally { skillsBusy.value = false }
}
async function scanSkills(addDirectory = false) {
  skillsBusy.value = true
  try { applySkills(await ipcRenderer.invoke(addDirectory ? 'skills:add-directory' : 'skills:refresh')); skillStatusMessage.value = `已发现 ${skillItems.value.length} 个 Skill。`; skillPreview.value = null }
  catch (error) { skillStatusMessage.value = error instanceof Error ? error.message : String(error) }
  finally { skillsBusy.value = false }
}
async function previewSkill(id: string) {
  try { skillPreview.value = await ipcRenderer.invoke('skills:preview', id) }
  catch (error) { skillStatusMessage.value = error instanceof Error ? error.message : String(error) }
}
function onSkillUsed(_event: unknown, history: typeof skillUseHistory.value, origin?: { conversationId: string }) {
  if (!origin || origin.conversationId === activeConversationId.value) skillUseHistory.value = history
}

// Long-term memory manager state
const showMemoryManager = ref(false)
const showAllFormalClaims = ref(false)
const memoryRoleLabels: Record<string, string> = {
  agent: '执行者', patient: '承受者', theme: '涉及对象', possessor: '所属者',
  subject: '主体', object: '对象', recipient: '接收方', source: '来源',
  destination: '目的地', location: '地点', time: '时间', instrument: '工具',
}
const memoryEnabled = ref(false)
const memoryCount = ref(0)
const memoryL1Count = ref<number | null>(null)
const graphClaimItems = ref<{ id: string; relation: string; arguments: { role: string; text: string }[];
  polarity: string; modality: string; time: string; sourceText: string;
  supplementalEvidence: { sourceId: string; text: string }[] }[]>([])
const memoryStoragePath = ref('')
const memoryItems = ref<MemoryItem[]>([])
const memoryReviewItems = ref<MemoryReviewItem[]>([])
const graphReviewItems = ref<GraphReviewItem[]>([])
const graphL1View = ref<{ manifestId: string; bundleId: string; claims: number; information: number; openAssertions: number; argumentEdges: number } | null>(null)
const graphOpenAssertionItems = ref<GraphOpenAssertionRecord[]>([])
const graphInformationItems = ref<Array<{ id: string; text: string; recordedAt: number; sourceId: string }>>([])
const graphExtractionStatus = ref<{ enabled: boolean; modelReady: boolean; error: string | null; runs: number;
  factCandidates: number; sourcesWithoutFacts: number; pendingReviews: number; claims: number;
  automaticOpenNavigation?: number; deferredOpenCandidates?: number; basicClaims?: number; basicRelations?: number } | null>(null)
const clarificationItems = ref<Array<{ id: string; candidateId: string; sourceRevision: string; sourceText: string; question: string; options?: string[] }>>([])
const clarificationContexts = ref<Array<{ id: string; text: string }>>([])
const clarificationReplies = ref<Record<string, string>>({})
const clarificationContextIds = ref<Record<string, string>>({})
const clarificationBusy = ref(false)
const clarificationError = ref('')
const semanticFailures = ref(0)
const semanticMigrationMessage = ref('')
const graphRelationMappings = ref<Array<{ id: string; active: boolean; sourceText: string; targetText: string }>>([])
async function revokeRelationMapping(id: string) {
  clarificationBusy.value = true
  try {
    const result = await ipcRenderer.invoke('memory:relation-mapping-revoke', id)
    semanticMigrationMessage.value = result?.ok ? '已撤销归并，相关记录将按独立关系重新整理。' : '撤销失败。'
    await refreshMemoryList()
  } finally { clarificationBusy.value = false }
}
async function migrateOpenL1() {
  clarificationBusy.value = true
  try {
    const result = await ipcRenderer.invoke('memory:open-l1-migrate')
    semanticMigrationMessage.value = result?.ok ? '已处理 ' + result.processed + ' 条，剩余 ' + result.remaining + ' 条。' : result?.error || '处理失败。'
    await refreshMemoryList()
  } finally { clarificationBusy.value = false }
}

async function answerClarification(item: typeof clarificationItems.value[number]) {
  clarificationBusy.value = true; clarificationError.value = ''
  try {
    const result = await ipcRenderer.invoke('memory:clarification-answer', { id: item.id, candidateId: item.candidateId,
      sourceRevision: item.sourceRevision, text: clarificationReplies.value[item.id + item.candidateId] ?? '',
      contextSourceId: clarificationContextIds.value[item.id + item.candidateId] || undefined })
    if (!result?.ok) clarificationError.value = result?.error || '补充信息处理失败。'
    await refreshMemoryStatus()
  } finally { clarificationBusy.value = false }
}
async function dismissClarification(item: typeof clarificationItems.value[number]) {
  await ipcRenderer.invoke('memory:clarification-dismiss', { id: item.id, candidateId: item.candidateId })
  await refreshMemoryStatus()
}
async function retrySemanticFailures() {
  clarificationBusy.value = true
  try { await ipcRenderer.invoke('memory:semantic-retry'); await refreshMemoryStatus() }
  finally { clarificationBusy.value = false }
}
const graphRelationReviewItems = ref<GraphRelationReviewItem[]>([])
const graphRelationReviewReasons = ref<Record<string, string>>({})
const graphL2Candidates = ref<GraphL2CandidateItem[]>([])
const graphL2PublishReasons = ref<Record<string, string>>({})
const graphL2View = ref<{ manifestId: string; candidates: number; relations: number } | null>(null)
const graphReviewReasons = ref<Record<string, string>>({})
const graphReviewErrors = ref<Record<string, string>>({})
const graphIdentityChoices = ref<Record<string, Record<string, string>>>({})
const graphContextChoices = ref<Record<string, { negation: string; condition: string; conditionText: string;
  time: string; speaker: string; speakerName: string }>>({})
function graphIdentityChoice(id: string): Record<string, string> {
  return graphIdentityChoices.value[id] ??= {}
}
function graphContextChoice(id: string) {
  return graphContextChoices.value[id] ??= {
    negation: '', condition: '', conditionText: '', time: '', speaker: '', speakerName: '',
  }
}
const graphRetrievalRetain = ref<Record<string, boolean>>({})
const graphProactivePreferences = ref<Record<string, boolean>>({})
const pendingCaptureSegments = ref(0)
const captureStatus = ref<{ activeSources: number; tasks: { failed: number; succeeded: number }; retryable: number; awaitingProcessor: number } | null>(null)
const manualMemoryInput = ref('')
const memoryLoading = ref(false)
const memoryMutating = ref(false)
const memoryStatusMessage = ref('')
const memoryStatusError = ref(false)
const graphDiagnosticLoading = ref(false)
const graphDiagnosticMessage = ref('')
async function inspectGraphInputs() {
  graphDiagnosticLoading.value = true
  graphDiagnosticMessage.value = ''
  try {
    const result = await ipcRenderer.invoke('memory:graph-diagnostics')
    if (!result?.ok) { graphDiagnosticMessage.value = result?.error || '诊断失败'; return }
    const report = result.report
    const reasons = report.reasons.filter((item: { count: number }) => item.count > 0)
      .map((item: { label: string; count: number }) => `${item.label}：${item.count}`).join('；')
    graphDiagnosticMessage.value = `图模式${result.graphEnabled ? '已启用' : '未启用'}；待写入 ${result.pendingWrites} 条。`
      + `当前用户和 Agent 的未绑定会话记录共 ${report.inScope} 条，可接入 ${report.eligible} 条，排除 ${report.excluded} 条。`
      + (reasons ? `排除原因：${reasons}。` : '') + report.note
      + `（数据版本 ${report.revision}；检查时间 ${new Date(report.checkedAt).toLocaleString()}，修改记忆后请重新检查。）`
  } catch { graphDiagnosticMessage.value = '无法获取诊断结果，请稍后重试。' }
  finally { graphDiagnosticLoading.value = false }
}
const pendingDeleteMemoryId = ref<string | null>(null)
const pendingPurgeMemoryId = ref<string | null>(null)
const purgeToken = ref('')
const purgePhrase = ref('')
const purgeWarning = ref('')
const editingMemoryId = ref<string | null>(null)
const editingMemoryContent = ref('')
const confirmClearMemories = ref(false)
const memorySettings = ref<MemorySettings>({
  extractionMode: 'rules',
  uieSupplementEnabled: true,
  graphExtractionEnabled: true,
  openSourceRecallEnabled: false,
  semanticEnabled: false,
  imageMemoryEnabled: true,
  remotePolicy: 'normal-only',
  v4RolloutStage: 'shadow',
})
const uiePreviewText = ref('')
const uiePreviewBusy = ref(false)
const uiePreviewResult = ref('')
const memoryEncrypted = ref(false)
const memoryV4RuntimeEnabled = ref(false)
const memoryV4EffectiveRolloutStage = ref<'shadow' | 'internal'>('shadow')
const memoryV4RolloutStageLocked = ref(false)
const memoryV4FeedbackCalibration = ref<any>(null)
const semanticInstalled = ref(false)
const semanticModelName = ref('Xenova/bge-small-zh-v1.5')
const semanticModelProgress = ref<{
  status: string
  progress?: number
  file?: string
  error?: string
  total?: number
  ready?: number
  pending?: number
  integrity?: string
  checkedFiles?: number
  checkedBytes?: number
}>({ status: 'idle' })
const semanticInstalling = ref(false)
const v4InternalFeedback = ref<Record<string, MemoryV4InternalFeedbackLabel>>({})
const v4InternalFeedbackPending = ref('')
const v4InternalFeedbackError = ref<Record<string, string>>({})

// Screen capture state
const pendingImage = ref<{ data: string; mimeType: string } | null>(null)
const isCapturing = ref(false)

// Voice state
const isListening = ref(false)
const autoSpeak = ref(false)
const voiceError = ref('')
const voiceSetup = ref<'idle' | 'checking' | 'needed' | 'installing' | 'ready'>('idle')
let mediaRecorder: MediaRecorder | null = null
let audioChunks: Blob[] = []

let resetTimer: ReturnType<typeof setTimeout> | null = null

const themeVars = computed(() => ({
  '--bg': currentTheme.value.bg,
  '--surface': currentTheme.value.surface,
  '--surface-hover': currentTheme.value.surfaceHover,
  '--border': currentTheme.value.border,
  '--text': currentTheme.value.text,
  '--text-muted': currentTheme.value.textMuted,
  '--accent': currentTheme.value.accent,
  '--accent-hover': currentTheme.value.accentHover,
  '--accent-soft': currentTheme.value.accentSoft,
  '--scroll-thumb': currentTheme.value.scrollThumb,
  '--sidebar': currentTheme.value.sidebar ?? currentTheme.value.surface,
  '--accent-ink': currentTheme.value.accentInk ?? currentTheme.value.accent,
  '--on-accent': currentTheme.value.onAccent ?? '#ffffff',
  '--marker': currentTheme.value.marker ?? currentTheme.value.accent,
  '--user-bubble': currentTheme.value.userBubble ?? currentTheme.value.accentSoft,
  '--color-scheme': currentTheme.value.scheme ?? 'light',
  '--logo-primary': currentTheme.value.logoPrimary ?? currentTheme.value.accentInk ?? currentTheme.value.accent,
  '--logo-secondary': currentTheme.value.logoSecondary ?? currentTheme.value.marker ?? currentTheme.value.accent,
}))

// ── Everyday chat utilities ─────────────────────────────
const quotedMessage = ref<MessageQuote | undefined>()
const draftStorage = useChatDrafts()
const draftStatus = draftStorage.status
const draftError = draftStorage.error
const quickPhrases = ref<QuickPhrase[]>([])
const showQuickPhrases = ref(false)
const showConversationSearch = ref(false)
const pinningConversation = ref('')
const exportingConversation = ref(false)
const highlightedMessageId = ref('')
const chatNotice = ref('')
let chatNoticeTimer: ReturnType<typeof setTimeout> | undefined
let highlightTimer: ReturnType<typeof setTimeout> | undefined
const orderedConversations = computed(() => conversations.value.filter(item => !item.archived).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)))

// ── Reading, navigation and response controls ───────────
const preferences = ref<ChatPreferences>(structuredClone(DEFAULT_CHAT_PREFERENCES))
const readerPreview = ref<ChatPreferences | undefined>()
const showGeneralSettings = ref(false)
const generalSettingsBusy = ref(false)
const generalSettingsError = ref('')
const showArchiveLibrary = ref(false)
const showSavedMessages = ref(false)
const bookmarks = ref<MessageBookmarkView[]>([])
const bookmarkBusy = ref(false)
const savedKeys = computed(() => new Set(bookmarks.value.map(item => bookmarkKey(item.conversationId, item.messageId))))
const showComposerEditor = ref(false)
const editorSelection = ref<EditorSelection>({ start: 0, end: 0, direction: 'none', scrollTop: 0 })
const showInputMenu = ref(false)
const followLatest = ref(true)
const unreadReply = ref(false)
let manualChatScroll = false
const stoppingConversations = ref(new Set<string>())
const stoppingGeneration = computed(() => stoppingConversations.value.has(activeConversationId.value))
const memoryActivity = ref<MemoryActivityReport>({ enabled: false, items: [], totals: { pending: 0, processing: 0, clarifying: 0, failed: 0, published: 0 }, awaitingProcessor: 0 })
const memoryActivityLoading = ref(false)
const showMemoryActivity = ref(false)
let memoryActivityTimer: ReturnType<typeof setInterval> | undefined
const currentArchived = computed(() => !!conversations.value.find(item => item.id === activeConversationId.value)?.archived)
const readerStyle = computed(() => {
  const reading = (readerPreview.value ?? preferences.value).reading
  return { '--reader-font-size': reading.fontSize ? `${reading.fontSize}px` : 'var(--reading-size)', '--reader-line-height': String(reading.lineHeight), '--reader-width': reading.contentWidth ? `${reading.contentWidth}px` : '1500px' }
})
const sendHint = computed(() => preferences.value.sendKey === 'ctrl-enter' ? 'Ctrl + Enter 发送 · Enter 换行' : 'Enter 发送 · Shift + Enter 换行')
const memoryActivitySummary = computed(() => {
  const t = memoryActivity.value.totals
  if (!memoryActivity.value.enabled) return '记忆未启用'
  if (t.processing) return `记忆处理中 · ${t.processing}`
  if (t.pending) return `记忆等待整理 · ${t.pending}`
  if (t.clarifying) return `记忆待补充 · ${t.clarifying}`
  if (t.failed) return `记忆处理失败 · ${t.failed}`
  return '记忆处理状态'
})
function openGeneralSettings() { showAppMenu.value = false; closeThemeMenu(true); generalSettingsError.value = ''; readerPreview.value = undefined; showGeneralSettings.value = true }
function closeGeneralSettings() { if (!generalSettingsBusy.value) { readerPreview.value = undefined; showGeneralSettings.value = false } }
async function saveGeneralSettings(value: ChatPreferences) {
  generalSettingsBusy.value = true; generalSettingsError.value = ''
  try {
    const result = await ipcRenderer.invoke('chat-ui:preferences-save', value)
    if (!result.ok) throw new Error(result.error)
    preferences.value = result.preferences
    readerPreview.value = undefined; showGeneralSettings.value = false
    notifyChat('设置已保存')
    resizeComposer()
  } catch (error) { generalSettingsError.value = error instanceof Error ? error.message : '设置保存失败。' }
  finally { generalSettingsBusy.value = false }
}
async function refreshBookmarks() {
  try { const result = await ipcRenderer.invoke('chat-ui:bookmarks-list'); if (!result.ok) throw new Error(result.error); bookmarks.value = result.items }
  catch (error) { notifyChat(error instanceof Error ? error.message : '收藏加载失败。') }
}
async function toggleBookmark(conversationId: string, messageId: string, saved: boolean) {
  if (bookmarkBusy.value) return
  bookmarkBusy.value = true
  try {
    const result = await ipcRenderer.invoke('chat-ui:bookmark-set', conversationId, messageId, saved)
    if (!result.ok) throw new Error(result.error)
    bookmarks.value = result.items
    notifyChat(saved ? '消息已收藏' : '已取消收藏')
  } catch (error) { notifyChat(error instanceof Error ? error.message : '收藏操作失败。') }
  finally { bookmarkBusy.value = false }
}
async function openSavedMessage(item: MessageBookmarkView) {
  await openSearchResult({ id: item.conversationId, title: item.conversationTitle, memorySpaceId: '', messageId: item.messageId })
  if (activeConversationId.value === item.conversationId) showSavedMessages.value = false
}
async function archiveConversation(id: string, archived: boolean) {
  try {
    const result = await ipcRenderer.invoke('conversations:archive', id, archived)
    if (!result.ok) throw new Error(result.error)
    conversations.value = result.conversations
    await refreshBookmarks()
    notifyChat(archived ? '对话已归档，可在归档列表恢复' : '对话已恢复到侧栏')
  } catch (error) { notifyChat(error instanceof Error ? error.message : '归档操作失败。') }
}
const pendingConversationDelete = ref<ConversationListItem | null>(null)
const conversationDeleteBusy = ref(false)
const conversationDeleteError = ref('')
function requestConversationDelete(conversation: ConversationListItem) {
  if (!canSwitchConversation.value) return
  pendingConversationDelete.value = { ...conversation }
  conversationDeleteError.value = ''
  showAppMenu.value = false
}
async function confirmConversationDelete() {
  const target = pendingConversationDelete.value
  if (!target || conversationDeleteBusy.value) return
  conversationDeleteBusy.value = true
  conversationSwitching.value = true
  conversationDeleteError.value = ''
  try {
    await draftStorage.flush()
    const result = await ipcRenderer.invoke('conversations:delete', target.id, { confirmed: true })
    if (!result.ok) throw new Error(result.error)
    draftStorage.forget(target.id)
    conversationMessages.delete(target.id); conversationImages.delete(target.id); memoryDrafts.delete(target.id)
    pendingConversations.delete(target.id); stoppingConversations.value.delete(target.id)
    bookmarks.value = result.bookmarks
    conversations.value = result.conversations
    if (activeConversationId.value === target.id) await applyConversationState(result)
    pendingConversationDelete.value = null
    notifyChat(result.warning || '对话已删除')
  } catch (error) { conversationDeleteError.value = error instanceof Error ? error.message : '删除失败，请重试。' }
  finally { conversationSwitching.value = false; conversationDeleteBusy.value = false; void refreshMemoryActivity().catch(() => {}) }
}

function expandComposer() {
  const t = composerTextarea.value
  if (!t || isLoading.value) return
  editorSelection.value = { start: t.selectionStart, end: t.selectionEnd, direction: t.selectionDirection, scrollTop: t.scrollTop }
  showInputMenu.value = false
  showComposerEditor.value = true
}
function closeComposerEditor(selection: EditorSelection, submit = false) {
  showComposerEditor.value = false; editorSelection.value = selection
  resizeComposer()
  nextTick(() => { const t = composerTextarea.value; t?.focus(); t?.setSelectionRange(selection.start, selection.end, selection.direction); if (t) t.scrollTop = selection.scrollTop; if (submit) void send() })
}
function markChatScroll() { manualChatScroll = true }
function onChatNavigation(event: KeyboardEvent) { if (['PageUp','PageDown','Home','End','ArrowUp','ArrowDown',' '].includes(event.key)) markChatScroll() }
function onChatScroll() {
  const el = chatEl.value
  if (!el || !manualChatScroll) return
  followLatest.value = el.scrollHeight - el.clientHeight - el.scrollTop < 60
  if (followLatest.value) unreadReply.value = false
}
async function stopGeneration() {
  const id = activeConversationId.value
  if (!isLoading.value || stoppingConversations.value.has(id)) return
  stoppingConversations.value.add(id)
  try { const result = await ipcRenderer.invoke('chat:stop'); if (!result.ok) throw new Error(result.error) }
  catch (error) { stoppingConversations.value.delete(id); notifyChat(error instanceof Error ? error.message : '停止请求失败。') }
}
async function refreshMemoryActivity() {
  if (memoryActivityLoading.value || conversationSwitching.value) return
  const id = activeConversationId.value
  memoryActivityLoading.value = true
  try { const result = await ipcRenderer.invoke('memory:activity'); if (id === activeConversationId.value && result?.ok) memoryActivity.value = result.report }
  catch { if (id === activeConversationId.value) memoryActivity.value = { ...memoryActivity.value, error: '状态更新失败，请稍后刷新。' } }
  finally { memoryActivityLoading.value = false }
}
function onVisibilityChange() {
  windowVisible.value = !document.hidden
  if (windowVisible.value) void refreshMemoryActivity().catch(() => {})
}

function notifyChat(message: string) {
  chatNotice.value = message
  clearTimeout(chatNoticeTimer)
  chatNoticeTimer = setTimeout(() => { chatNotice.value = '' }, 4000)
}
watch(draftError, error => { if (error) notifyChat(error) })
function currentDraft() {
  return { text: input.value, ...(quotedMessage.value ? { quote: { ...quotedMessage.value } } : {}), ...(selectedSkillId.value ? { skillId: selectedSkillId.value } : {}) }
}
function messageSelection(message: Message): string {
  const selection = window.getSelection()
  const container = [...document.querySelectorAll<HTMLElement>('.message')].find(element => element.dataset.messageId === message.id)?.querySelector('.message-markdown')
  if (selection && container && container.contains(selection.anchorNode) && container.contains(selection.focusNode)) return selection.toString().trim()
  return ''
}
async function copyMessage(message: Message) {
  try {
    const result = await ipcRenderer.invoke('chat-ui:copy', messageSelection(message) || message.content)
    if (!result.ok) throw new Error(result.error)
    notifyChat('消息已复制')
  } catch (error) { notifyChat(error instanceof Error ? error.message : '复制失败，请重试。') }
}
function quoteMessage(message: Message) {
  const content = messageSelection(message) || message.content
  if (!content.trim()) return
  if (content.length > 12000) { notifyChat('引用最多 12000 字，请选中需要引用的片段。'); return }
  quotedMessage.value = { messageId: message.id, role: message.role, content }
  nextTick(() => composerTextarea.value?.focus())
}
async function pinConversation(id: string, pinned: boolean) {
  if (pinningConversation.value) return
  pinningConversation.value = id
  try {
    const result = await ipcRenderer.invoke('conversations:pin', id, pinned)
    if (!result.ok) throw new Error(result.error)
    conversations.value = result.conversations
    notifyChat(pinned ? '对话已置顶' : '已取消置顶')
  } catch (error) { notifyChat(error instanceof Error ? error.message : '置顶失败，请重试。') }
  finally { pinningConversation.value = '' }
}
async function openSearchResult(result: ConversationSearchResult) {
  await selectConversation(result.id)
  if (activeConversationId.value !== result.id) return
  showConversationSearch.value = false
  if (result.messageId) {
    followLatest.value = false; manualChatScroll = true
    highlightedMessageId.value = result.messageId
    clearTimeout(highlightTimer)
    highlightTimer = setTimeout(() => { highlightedMessageId.value = '' }, 4000)
    nextTick(() => [...document.querySelectorAll<HTMLElement>('.message')].find(element => element.dataset.messageId === result.messageId)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
  }
}
function insertPhrase(content: string) {
  const textarea = composerTextarea.value
  const start = textarea?.selectionStart ?? input.value.length
  const end = textarea?.selectionEnd ?? input.value.length
  const before = input.value.slice(0, start), after = input.value.slice(end)
  const insertion = `${before && !/\s$/.test(before) ? '\n' : ''}${content}${after && !/^\s/.test(after) ? '\n' : ''}`
  input.value = before + insertion + after
  showQuickPhrases.value = false
  nextTick(() => { textarea?.focus(); textarea?.setSelectionRange(start + insertion.length, start + insertion.length) })
}
async function exportConversation(format: 'md' | 'txt') {
  if (exportingConversation.value || isLoading.value) return
  exportingConversation.value = true
  showAppMenu.value = false
  try {
    const result = await ipcRenderer.invoke('conversations:export', activeConversationId.value, format)
    if (!result.ok) throw new Error(result.error)
    if (!result.canceled) notifyChat(`已导出：${result.filename}`)
  } catch (error) { notifyChat(error instanceof Error ? error.message : '导出失败，请重试。') }
  finally { exportingConversation.value = false }
}
function onChatShortcut(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || document.querySelector('.modal-backdrop')) return
  const key = shortcutFromEvent(event), shortcuts = preferences.value.shortcuts
  if (key === shortcuts.newConversation) { event.preventDefault(); void selectConversation() }
  else if (key === shortcuts.focusInput) { event.preventDefault(); composerTextarea.value?.focus() }
  else if (key === shortcuts.search) { event.preventDefault(); showConversationSearch.value = true }
}

// ── IPC token handler ───────────────────────────────────
function onToken(_event: unknown, token: string, origin?: { conversationId: string }) {
  const id = origin?.conversationId ?? activeConversationId.value
  const target = id === activeConversationId.value ? messages.value : conversationMessages.get(id)
  const last = target?.[target.length - 1]
  if (last && last.role === 'assistant') {
    last.content += token
    if (id === activeConversationId.value) { if (followLatest.value) scrollToBottom(false); else unreadReply.value = true }
  }
}

function onMemoryModelProgress(_event: unknown, progress: typeof semanticModelProgress.value, origin?: { conversationId: string }) {
  if (origin && origin.conversationId !== activeConversationId.value) return
  semanticModelProgress.value = progress
}

watch([input, quotedMessage, selectedSkillId], () => {
  if (loaded.value && !conversationSwitching.value) draftStorage.queue(activeConversationId.value, currentDraft())
}, { flush: 'sync' })

// ── Lifecycle ───────────────────────────────────────────
onMounted(async () => {
  window.addEventListener('resize', updateCompactComposer)
  document.addEventListener('pointerdown', dismissHeaderMenus)
  document.addEventListener('keydown', onHeaderEscape)
  document.addEventListener('keydown', onChatShortcut)
  document.addEventListener('visibilitychange', onVisibilityChange)
  appVersion.value = await ipcRenderer.invoke('app:version')
  const settings = await ipcRenderer.invoke('settings:get')
  if (settings.agentName) {
    agentName.value = settings.agentName
    isFirstRun.value = false
  }
  if (settings.theme) {
    if (typeof settings.theme === 'string' && settings.theme.startsWith(CUSTOM_THEME_PREFIX)) {
      const savedColor = settings.theme.slice(CUSTOM_THEME_PREFIX.length)
      if (parseHexColor(savedColor)) {
        customColor.value = savedColor.toLowerCase()
        currentTheme.value = createCustomTheme(customColor.value)
      }
    }
    else {
      const t = resolveTheme(settings.theme)
      if (t) currentTheme.value = t
    }
  }

  await refreshApiStatus()
  const conversationState = await ipcRenderer.invoke('conversations:list')
  conversations.value = conversationState.conversations
  activeConversationId.value = conversationState.activeId
  selectedConversationId.value = conversationState.activeId
  try {
    const ui = await draftStorage.load()
    quickPhrases.value = ui.phrases ?? []
    if (ui.preferences) preferences.value = ui.preferences
    const draft = draftStorage.get(activeConversationId.value)
    input.value = draft.text
    quotedMessage.value = draft.quote
    selectedSkillId.value = draft.skillId ?? ''
  } catch (error) { notifyChat(error instanceof Error ? error.message : '草稿加载失败。') }
  await refreshMemoryStatus()
  await refreshSkills()
  await refreshDocuments()

  const history = await ipcRenderer.invoke('sessions:history')
  if (history && history.length > 0) {
    messages.value = history
      .filter((h: { role: string }) => h.role === 'user' || h.role === 'assistant')
      .map((h: { id?: string; role: 'user' | 'assistant'; content: string; quote?: MessageQuote; status?: 'failed' | 'stopped'; replyTo?: string; hasImage?: boolean }) => ({
        id: h.id || crypto.randomUUID(),
        role: h.role,
        content: h.content,
        quote: h.quote, status: h.status, replyTo: h.replyTo, hasImage: h.hasImage, persisted: true,
      }))
  }

  loaded.value = true
  await refreshBookmarks()
  void refreshMemoryActivity().catch(() => {})
  memoryActivityTimer = setInterval(() => { if (!document.hidden) void refreshMemoryActivity().catch(() => {}) }, 2000)
  resizeComposer()
  void document.fonts.ready.then(resizeComposer)
  conversationMessages.set(activeConversationId.value, messages.value)
  if (!isFirstRun.value)
    scrollToBottom()

  ipcRenderer.on('chat:token', onToken)
  ipcRenderer.on('memory:model-progress', onMemoryModelProgress)
  ipcRenderer.on('memory:changed', onMemoryChanged)
  ipcRenderer.on('skills:used', onSkillUsed)
  ipcRenderer.on('documents:changed', onDocumentsChanged)
})

onUnmounted(() => {
  composerResizeObserver.disconnect()
  window.removeEventListener('resize', updateCompactComposer)
  document.removeEventListener('pointerdown', dismissHeaderMenus)
  document.removeEventListener('keydown', onHeaderEscape)
  document.removeEventListener('keydown', onChatShortcut)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  clearInterval(memoryActivityTimer)
  clearTimeout(chatNoticeTimer)
  clearTimeout(highlightTimer)
  ipcRenderer.removeListener('chat:token', onToken)
  ipcRenderer.removeListener('memory:model-progress', onMemoryModelProgress)
  ipcRenderer.removeListener('memory:changed', onMemoryChanged)
  ipcRenderer.removeListener('skills:used', onSkillUsed)
  ipcRenderer.removeListener('documents:changed', onDocumentsChanged)
  if (resetTimer) clearTimeout(resetTimer)
  if (mediaRecorder) {
    mediaRecorder.stop()
    mediaRecorder.stream.getTracks().forEach(t => t.stop())
    mediaRecorder = null
  }
  isListening.value = false
  speechSynthesis.cancel()
})

// ── Naming ──────────────────────────────────────────────
async function confirmName(event?: KeyboardEvent | MouseEvent) {
  if (event instanceof KeyboardEvent && (event.isComposing || event.keyCode === 229)) return
  const name = nameInput.value.trim()
  if (!name) return
  await ipcRenderer.invoke('settings:set-name', name)
  agentName.value = name
  isFirstRun.value = false
}

// ── API settings ────────────────────────────────────────
async function refreshApiStatus() {
  try {
    const status = await ipcRenderer.invoke('api:get')
    apiConfigured.value = !!status.configured
    apiBaseURL.value = status.baseURL || 'https://api.openai.com/v1'
    apiModel.value = status.model || 'gpt-4o-mini'
    return true
  }
  catch {
    apiConfigured.value = false
    return false
  }
}

async function openApiSettings() {
  closeThemeMenu(true)
  if (!apiDraftLoaded.value) {
    await refreshApiStatus()
    apiDraftLoaded.value = true
  }
  apiStatusMessage.value = ''
  apiStatusError.value = false
  showMemoryManager.value = false
  showApiSettings.value = true
}

function closeApiSettings() {
  if (!apiSaving.value)
    showApiSettings.value = false
}
async function restoreApiDraft() {
  if (apiSaving.value) return
  if (!await refreshApiStatus()) {
    apiStatusError.value = true
    apiStatusMessage.value = '读取已保存配置失败，当前输入已保留。'
    return
  }
  apiKeyInput.value = ''
  apiStatusError.value = false
  apiStatusMessage.value = '已恢复保存的地址与模型，未保存的新密钥已清空。'
}

async function saveApiSettings(event?: KeyboardEvent | MouseEvent) {
  if (apiSaving.value || (event instanceof KeyboardEvent && (event.isComposing || event.keyCode === 229))) return
  apiSaving.value = true
  apiStatusMessage.value = ''
  apiStatusError.value = false
  try {
    const result = await ipcRenderer.invoke('api:set', {
      apiKey: apiKeyInput.value,
      baseURL: apiBaseURL.value,
      model: apiModel.value,
    })
    if (!result?.ok) {
      apiStatusError.value = true
      apiStatusMessage.value = result?.error || '保存失败。'
      return
    }
    apiConfigured.value = true
    apiKeyInput.value = ''
    apiStatusMessage.value = '保存成功，新配置已立即生效。'
  }
  catch (error) {
    apiStatusError.value = true
    apiStatusMessage.value = error instanceof Error ? error.message : '保存失败。'
  }
  finally {
    apiSaving.value = false
  }
}

// ── Long-term memory manager ────────────────────────────
function onMemoryChanged(_event?: unknown, _payload?: unknown, origin?: { conversationId: string }) {
  if (origin && origin.conversationId !== activeConversationId.value) return
  void refreshMemoryActivity().catch(() => {})
  if (!isLoading.value && !conversationSwitching.value) void refreshMemoryStatus()
}
function displayHistory(history: { id?: string; role: string; content: string; quote?: MessageQuote; status?: 'failed' | 'stopped'; replyTo?: string; hasImage?: boolean }[]): Message[] {
  return history.filter(h => h.role === 'user' || h.role === 'assistant').map(h => ({
    id: h.id || crypto.randomUUID(), role: h.role as 'user' | 'assistant', content: h.content, quote: h.quote, status: h.status, replyTo: h.replyTo, hasImage: h.hasImage, persisted: true,
  }))
}
async function selectConversation(id?: string) {
  if (!canSwitchConversation.value || id === activeConversationId.value) return
  draftStorage.queue(activeConversationId.value, currentDraft())
  conversationSwitching.value = true
  await draftStorage.flush()
  conversationError.value = ''
  const previousId = activeConversationId.value
  conversationMessages.set(previousId, messages.value)
  conversationImages.set(previousId, pendingImage.value)
  memoryDrafts.set(previousId, { manual: manualMemoryInput.value, preview: uiePreviewText.value,
    editingId: editingMemoryId.value, editingContent: editingMemoryContent.value, replies: { ...clarificationReplies.value } })
  try {
    const result = id ? await ipcRenderer.invoke('conversations:select', id)
      : await ipcRenderer.invoke('conversations:create', `新对话 ${conversations.value.length}`)
    if (!result.ok) throw new Error(result.error)
    await applyConversationState(result)
  } catch (error) {
    conversationError.value = error instanceof Error ? error.message : String(error)
  } finally { conversationSwitching.value = false; void refreshMemoryActivity().catch(() => {}) }
}
async function applyConversationState(result: { conversations: ConversationListItem[]; activeId: string; history: Parameters<typeof displayHistory>[0] }) {
  conversations.value = result.conversations
  activeConversationId.value = result.activeId
  selectedConversationId.value = result.activeId
  const draft = draftStorage.get(result.activeId)
  selectedSkillId.value = draft.skillId ?? ''
  quotedMessage.value = draft.quote
  skillUseHistory.value = []
  documentItems.value = []
  documentPreview.value = null
  documentMessage.value = ''
  showDocumentManager.value = false
  messages.value = pendingConversations.has(result.activeId)
    ? conversationMessages.get(result.activeId) ?? displayHistory(result.history)
    : displayHistory(result.history)
  conversationMessages.set(result.activeId, messages.value)
  input.value = draft.text
  pendingImage.value = conversationImages.get(result.activeId) ?? null
  isLoading.value = pendingConversations.has(result.activeId)
  showMemoryManager.value = false
  showAllFormalClaims.value = false
  clarificationItems.value = []
  clarificationContexts.value = []
  const memoryDraft = memoryDrafts.get(result.activeId)
  manualMemoryInput.value = memoryDraft?.manual ?? ''
  uiePreviewText.value = memoryDraft?.preview ?? ''
  uiePreviewResult.value = ''
  editingMemoryId.value = memoryDraft?.editingId ?? null
  editingMemoryContent.value = memoryDraft?.editingContent ?? ''
  clarificationReplies.value = memoryDraft?.replies ?? {}
  cancelPurgeMemory()
  pendingDeleteMemoryId.value = null
  confirmClearMemories.value = false
  renamingConversation.value = false
  memoryItems.value = []
  graphClaimItems.value = []
  graphInformationItems.value = []
  graphOpenAssertionItems.value = []
  memoryStatusMessage.value = ''
  memoryCount.value = 0
  memoryL1Count.value = null
  await refreshMemoryStatus()
  await refreshSkills()
  await refreshDocuments()
  scrollToBottom()
  memoryActivity.value = { enabled: false, items: [], totals: { pending: 0, processing: 0, clarifying: 0, failed: 0, published: 0 }, awaitingProcessor: 0 }
}

async function renameConversation(event?: KeyboardEvent | MouseEvent) {
  if (event instanceof KeyboardEvent && (event.isComposing || event.keyCode === 229)) return
  const title = conversationRenameInput.value.trim()
  if (!title) return
  try {
    const result = await ipcRenderer.invoke('conversations:rename', activeConversationId.value, title)
    conversations.value = result.conversations
    renamingConversation.value = false
  } catch (error) { conversationError.value = error instanceof Error ? error.message : String(error) }
}
async function refreshMemoryStatus() {
  try {
    const requestedConversation = activeConversationId.value
    const status = await ipcRenderer.invoke('memory:status')
    if (requestedConversation !== activeConversationId.value) return
    const clarifications = await ipcRenderer.invoke('memory:clarifications-list')
    if (requestedConversation !== activeConversationId.value) return
    clarificationItems.value = clarifications?.items ?? []
    clarificationContexts.value = clarifications?.contexts ?? []
    semanticFailures.value = clarifications?.failed ?? 0
    memoryEnabled.value = !!status?.enabled
    memoryCount.value = Number(status?.count) || 0
    memoryL1Count.value = Number(status?.graphClaimCount) || 0
    memoryStoragePath.value = status?.storagePath || ''
    applyMemoryRuntimeStatus(status)
    if (status?.error) {
      memoryStatusError.value = true
      memoryStatusMessage.value = status.error
    }
  }
  catch {
    memoryEnabled.value = false
    memoryCount.value = 0
  }
}

function applyMemoryRuntimeStatus(status: any) {
  if (status?.settings)
    memorySettings.value = { ...memorySettings.value, ...status.settings }
  memoryEncrypted.value = !!status?.encrypted
  memoryV4RuntimeEnabled.value = !!status?.v4?.enabled
  memoryV4EffectiveRolloutStage.value = status?.v4?.shadowRead?.rolloutStage === 'internal'
    ? 'internal'
    : 'shadow'
  memoryV4RolloutStageLocked.value = !!status?.v4?.shadowRead?.rolloutStageLocked
  memoryV4FeedbackCalibration.value = status?.v4?.shadowRead?.internalFeedbackCalibration || null
  const integrityState = status?.semantic?.integrity?.state
  semanticInstalled.value = !!status?.semantic?.installed
    && integrityState !== 'corrupt'
    && integrityState !== 'incompatible'
  semanticModelName.value = status?.semantic?.model || semanticModelName.value
  if (status?.semantic?.progress)
    semanticModelProgress.value = status.semantic.progress
}

async function openMemoryManager() {
  showApiSettings.value = false
  closeThemeMenu(true)
  memoryStatusMessage.value = ''
  memoryStatusError.value = false
  pendingDeleteMemoryId.value = null
  cancelPurgeMemory()
  confirmClearMemories.value = false
  showMemoryManager.value = true
  await refreshMemoryList()
}

function closeMemoryManager() {
  if (!memoryMutating.value)
    showMemoryManager.value = false
}

async function refreshMemoryList() {
  memoryLoading.value = true
  try {
    const result = await ipcRenderer.invoke('memory:list', 1000)
    if (!result?.ok) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result?.error || '读取记忆失败。'
      return
    }
    memoryEnabled.value = !!result.enabled
    memoryCount.value = Number(result.count) || 0
    memoryStoragePath.value = result.storagePath || ''
    memoryItems.value = Array.isArray(result.items) ? result.items : []
    memoryReviewItems.value = Array.isArray(result.reviewItems) ? result.reviewItems : []
    graphReviewItems.value = Array.isArray(result.graphReviewItems) ? result.graphReviewItems : []
    graphL1View.value = result.graphL1View ?? null
    graphRelationMappings.value = result.relationMappings ?? []
    graphInformationItems.value = Array.isArray(result.graphInformationItems) ? result.graphInformationItems : []
    graphOpenAssertionItems.value = Array.isArray(result.graphOpenAssertionItems) ? result.graphOpenAssertionItems : []
    graphExtractionStatus.value = result.graphExtraction ?? null
    memoryL1Count.value = Number(result.graphExtraction?.claims) || 0
    graphClaimItems.value = result.graphClaimItems ?? []
    graphRelationReviewItems.value = Array.isArray(result.graphRelationReviewItems) ? result.graphRelationReviewItems : []
    graphL2Candidates.value = Array.isArray(result.graphL2Candidates) ? result.graphL2Candidates : []
    graphL2View.value = result.graphL2View ?? null
    for (const item of graphReviewItems.value) {
      graphRetrievalRetain.value[item.review.id] ??= item.review.retrieval.retain
      graphProactivePreferences.value[item.review.id] ??= item.review.proactive.useAsPreference
      graphIdentityChoices.value[item.review.id] ??= Object.fromEntries(item.mentions.map(mention =>
        [mention.id, mention.resolvedEntityId ?? '']))
      graphContextChoices.value[item.review.id] ??= {
        negation: '', condition: '', conditionText: '', time: '', speaker: '', speakerName: '',
      }
    }
    pendingCaptureSegments.value = Number(result.pendingCaptureSegments) || 0
    captureStatus.value = result.capture || null
    applyMemoryRuntimeStatus(result)
    if (result.error) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result.error
    }
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : '读取记忆失败。'
  }
  finally {
    memoryLoading.value = false
  }
}

async function reviewMemoryCandidate(id: string, outcome: 'approved' | 'rejected') {
  if (memoryMutating.value) return
  memoryMutating.value = true
  memoryStatusError.value = false
  try {
    const result = await ipcRenderer.invoke('memory:candidate-review', { id, outcome })
    if (!result?.ok) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result?.error || '候选审核失败。'
      return
    }
    memoryStatusMessage.value = outcome === 'approved'
      ? '候选已由你确认，并作为手动确认事实进入正式记忆。'
      : '候选已拒绝，不会进入正式记忆。'
    await refreshMemoryList()
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : '候选审核失败。'
  }
  finally {
    memoryMutating.value = false
  }
}

async function reextractEmptyGraphSources() {
  if (memoryMutating.value) return
  memoryMutating.value = true
  memoryStatusError.value = false
  memoryStatusMessage.value = '正在用本地 UIE 重新提取，首次加载模型可能需要一些时间…'
  try {
    const result = await ipcRenderer.invoke('memory:graph-reextract-empty')
    memoryStatusError.value = !result?.ok
    memoryStatusMessage.value = result?.ok
      ? `已重新提取 ${result.processed} 条来源，生成 ${result.candidates} 条图事实候选；仍有 ${result.remaining} 条来源未形成事实。请在下方审核候选。`
      : `重新提取未完成：${result?.error || '未知错误'}（已处理 ${result?.processed || 0} 条来源）`
    await refreshMemoryList()
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : '重新提取失败。'
  }
  finally { memoryMutating.value = false }
}

async function reassessPendingGraphFacts() {
  if (memoryMutating.value) return
  memoryMutating.value = true
  memoryStatusError.value = false
  memoryStatusMessage.value = '正在根据保留的原文与 UIE 结果重新审核图事实…'
  try {
    const result = await ipcRenderer.invoke('memory:graph-auto-reassess')
    memoryStatusError.value = !result?.ok || result.failed > 0
    memoryStatusMessage.value = result?.ok
      ? `已尝试自动审核 ${result.reviewed} 条，发布 ${result.published} 条；另有 ${result.deferred} 条保持待审，${result.failed} 条发布未完成。`
      : result?.error || '图事实自动重审失败。'
    await refreshMemoryList()
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : '图事实自动重审失败。'
  }
  finally { memoryMutating.value = false }
}

async function reviewGraphCandidate(id: string, outcome: 'approved' | 'rejected' | 'pending') {
  if (memoryMutating.value) return
  const reason = graphReviewReasons.value[id]?.trim()
  if (!reason) return
  graphReviewErrors.value[id] = ''
  memoryMutating.value = true
  memoryStatusError.value = false
  try {
    const fields = graphReviewIpcFields(graphContextChoices.value[id], graphIdentityChoices.value[id])
    const result = await ipcRenderer.invoke('memory:graph-review', {
      id, outcome, reason,
      retrievalRetain: graphRetrievalRetain.value[id] !== false,
      proactivePreference: graphProactivePreferences.value[id] === true,
      sourceRevision: graphReviewItems.value.find(item => item.review.id === id)?.review.sourceRevision,
      ...fields,
    })
    if (!result?.ok) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result?.error || '图事实审核失败。'
      graphReviewErrors.value[id] = memoryStatusMessage.value
      return
    }
    memoryStatusMessage.value = outcome === 'approved'
      ? result.published ? '图事实已确认并写入。' : '审核已保存，发布任务等待重试。'
      : outcome === 'rejected' ? '已拒绝规范事实，并限制对应来源使用。' : '已保留未发布状态，不因此撤销原文召回权限。'
    delete graphReviewReasons.value[id]
    await refreshMemoryList()
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : '图事实审核失败。'
    graphReviewErrors.value[id] = memoryStatusMessage.value
  }
  finally {
    memoryMutating.value = false
  }
}

function graphApprovalReady(item: GraphReviewItem): boolean {
  const context = graphContextChoices.value[item.review.id]
  const identities = graphIdentityChoices.value[item.review.id]
  return !!context && !!identities && !!context.negation && !!context.condition && !!context.time && !!context.speaker
    && !graphReviewTimeError(context.time)
    && (context.condition !== 'conditional' || !!context.conditionText.trim())
    && (context.speaker !== 'reported' || !!context.speakerName.trim())
    && item.mentions.every(mention => !!identities[mention.id])
}

async function reviewGraphRelation(key: string, outcome: 'accepted' | 'rejected' | 'pending') {
  if (memoryMutating.value) return
  const reason = graphRelationReviewReasons.value[key]?.trim()
  if (!reason) return
  memoryMutating.value = true
  try {
    const result = await ipcRenderer.invoke('memory:graph-relation-review', { key, outcome, reason })
    if (!result?.ok) throw new Error(result?.error || '信息关系审核失败。')
    memoryStatusError.value = false
    memoryStatusMessage.value = outcome === 'accepted'
      ? '人工审核已记录；该判断尚未发布为正式 L2 关系。'
      : outcome === 'rejected' ? '信息关系候选已拒绝。' : '信息关系候选保持待确认。'
    delete graphRelationReviewReasons.value[key]
    await refreshMemoryList()
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : '信息关系审核失败。'
  }
  finally { memoryMutating.value = false }
}
async function publishGraphL2Relation(candidateId: string) {
  if (memoryMutating.value) return
  const reason = graphL2PublishReasons.value[candidateId]?.trim()
  if (!reason) return
  memoryMutating.value = true
  try {
    const result = await ipcRenderer.invoke('memory:graph-l2-publish', { candidateId, reason })
    if (!result?.ok) throw new Error(result?.error || 'L2 关系发布失败。')
    memoryStatusError.value = false
    memoryStatusMessage.value = '人工核实的 L2 关系已发布；模型分数仍只是观察记录。'
    delete graphL2PublishReasons.value[candidateId]
    await refreshMemoryList()
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : 'L2 关系发布失败。'
  }
  finally { memoryMutating.value = false }
}

async function reprocessMemoryCandidates() {
  if (memoryMutating.value) return
  memoryMutating.value = true
  memoryStatusError.value = false
  try {
    let cursor: string | undefined
    let processed = 0
    let changed = 0
    let calibrationSamples = 0
    do {
      const result = await ipcRenderer.invoke('memory:candidate-reprocess', { cursor, batchSize: 100 })
      if (!result?.ok) {
        memoryStatusError.value = true
        memoryStatusMessage.value = result?.error || '候选重处理失败。'
        return
      }
      processed += Number(result.report?.processed) || 0
      changed += Number(result.report?.changedDecisions) || 0
      calibrationSamples = Number(result.report?.calibration?.sampleCount) || 0
      cursor = result.report?.nextCursor
    } while (cursor)
    memoryStatusMessage.value = `影子重处理完成：检查 ${processed} 条候选，发现 ${changed} 条策略差异；使用 ${calibrationSamples} 条隔离审核反馈，仅供影子比较，不具备生产校准资格。`
    await refreshMemoryList()
  }
  finally {
    memoryMutating.value = false
  }
}

async function flushMemoryCaptureQueue() {
  if (memoryMutating.value) return
  memoryMutating.value = true
  try {
    const result = await ipcRenderer.invoke('memory:capture-flush')
    if (!result?.ok) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result?.error || '后台写入队列处理失败。'
      return
    }
    memoryStatusMessage.value = '后台长消息写入队列已全部处理。'
    await refreshMemoryList()
  }
  finally {
    memoryMutating.value = false
  }
}

async function retryMemoryCaptureTasks() {
  if (memoryMutating.value) return
  memoryMutating.value = true
  try {
    const result = await ipcRenderer.invoke('memory:capture-retry')
    memoryStatusError.value = !result?.ok
    memoryStatusMessage.value = result?.ok ? '本轮重试已结束，请查看任务状态。' : result?.error || '捕获任务重试失败。'
    await refreshMemoryList()
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : String(error)
  }
  finally {
    memoryMutating.value = false
  }
}

async function saveMemorySettings(patch: Partial<MemorySettings>) {
  if (memoryMutating.value) return
  memoryMutating.value = true
  memoryStatusMessage.value = ''
  memoryStatusError.value = false
  try {
    const result = await ipcRenderer.invoke('memory:settings-set', patch)
    if (!result?.ok) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result?.error || '记忆设置保存失败。'
    }
    if (result?.settings)
      memorySettings.value = { ...memorySettings.value, ...result.settings }
    await refreshMemoryList()
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : '记忆设置保存失败。'
  }
  finally {
    memoryMutating.value = false
  }
}

async function previewUieExtraction() {
  if (uiePreviewBusy.value || !uiePreviewText.value.trim()) return
  uiePreviewBusy.value = true
  uiePreviewResult.value = ''
  try {
    const result = await ipcRenderer.invoke('memory:uie-extract', uiePreviewText.value)
    uiePreviewResult.value = result?.ok
      ? JSON.stringify({ entities: result.extraction.entities, fields: result.extraction.fields,
        relations: result.extraction.relations, graphPreview: result.graphPreview }, null, 2)
      : (result?.error || '提取失败。')
  }
  catch (error) {
    uiePreviewResult.value = error instanceof Error ? error.message : '提取失败。'
  }
  finally {
    uiePreviewBusy.value = false
  }
}

async function installSemanticModel() {
  if (semanticInstalling.value) return
  semanticInstalling.value = true
  memoryStatusMessage.value = '正在下载并校验本地语义模型，首次安装可能需要几分钟…'
  memoryStatusError.value = false
  try {
    const result = await ipcRenderer.invoke('memory:model-install')
    if (!result?.ok) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result?.error || '本地语义模型安装失败。'
      return
    }
    semanticInstalled.value = true
    memorySettings.value = { ...memorySettings.value, ...result.settings }
    memoryStatusMessage.value = '本地语义模型及旧记忆索引已准备完成，语义检索已原子启用。'
    await refreshMemoryList()
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : '本地语义模型安装失败。'
  }
  finally {
    semanticInstalling.value = false
  }
}

async function updateMemory(item: MemoryItem, patch: Record<string, unknown>) {
  if (memoryMutating.value) return
  memoryMutating.value = true
  memoryStatusError.value = false
  try {
    const result = await ipcRenderer.invoke('memory:update', item.id, patch)
    if (!result?.ok) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result?.error || '更新记忆失败。'
      return
    }
    memoryStatusMessage.value = '记忆设置已更新。'
    await refreshMemoryList()
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : '更新记忆失败。'
  }
  finally {
    memoryMutating.value = false
  }
}

function beginEditMemory(item: MemoryItem) {
  editingMemoryId.value = item.id
  editingMemoryContent.value = item.content
}

function cancelEditMemory() {
  editingMemoryId.value = null
  editingMemoryContent.value = ''
}

async function saveEditedMemory(item: MemoryItem) {
  const content = editingMemoryContent.value.trim()
  if (!content || content === item.content) {
    cancelEditMemory()
    return
  }
  await updateMemory(item, { content })
  if (!memoryStatusError.value)
    cancelEditMemory()
}

async function suppressMemory(item: MemoryItem) {
  await updateMemory(item, { status: 'suppressed' })
  if (!memoryStatusError.value)
    memoryStatusMessage.value = '记忆已停用，不再参与普通召回；可随时恢复。'
}

async function updateMemorySensitivity(item: MemoryItem) {
  await updateMemory(item, {
    sensitivity: item.sensitivity,
    ...(item.sensitivity === 'secret' ? { sharePolicy: 'local-only' } : {}),
  })
}

async function restoreMemory(item: MemoryItem) {
  if (memoryMutating.value) return
  memoryMutating.value = true
  try {
    const result = await ipcRenderer.invoke('memory:restore', item.id)
    if (!result?.ok) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result?.error || '恢复记忆失败。'
      return
    }
    memoryStatusError.value = false
    memoryStatusMessage.value = '记忆已恢复为有效状态。'
    await refreshMemoryList()
  }
  finally {
    memoryMutating.value = false
  }
}

async function addManualMemory(event?: KeyboardEvent | MouseEvent) {
  if (event instanceof KeyboardEvent && (event.isComposing || event.keyCode === 229)) return
  event?.preventDefault()
  const content = manualMemoryInput.value.trim()
  if (!content || memoryMutating.value) return
  memoryMutating.value = true
  memoryStatusMessage.value = ''
  memoryStatusError.value = false
  try {
    const result = await ipcRenderer.invoke('memory:add', content)
    if (!result?.ok) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result?.error || '添加记忆失败。'
      return
    }
    manualMemoryInput.value = ''
    memoryStatusMessage.value = '记忆已保存。'
    await refreshMemoryList()
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : '添加记忆失败。'
  }
  finally {
    memoryMutating.value = false
  }
}

async function deleteMemory(id: string) {
  if (pendingDeleteMemoryId.value !== id) {
    pendingDeleteMemoryId.value = id
    return
  }
  if (memoryMutating.value) return
  memoryMutating.value = true
  memoryStatusMessage.value = ''
  memoryStatusError.value = false
  try {
    const result = await ipcRenderer.invoke('memory:forget', id)
    if (!result?.ok) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result?.error || '删除记忆失败。'
      return
    }
    pendingDeleteMemoryId.value = null
    memoryStatusMessage.value = '记忆已删除。'
    await refreshMemoryList()
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : '删除记忆失败。'
  }
  finally {
    memoryMutating.value = false
  }
}

async function preparePurgeMemory(id: string) {
  if (memoryMutating.value) return
  memoryStatusMessage.value = ''
  memoryStatusError.value = false
  try {
    const result = await ipcRenderer.invoke('memory:purge-prepare', id)
    if (!result?.ok) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result?.error || '无法发起彻底清除。'
      return
    }
    pendingPurgeMemoryId.value = id
    purgeToken.value = result.token
    purgePhrase.value = ''
    purgeWarning.value = result.warning
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : '无法发起彻底清除。'
  }
}

function cancelPurgeMemory() {
  pendingPurgeMemoryId.value = null
  purgeToken.value = ''
  purgePhrase.value = ''
  purgeWarning.value = ''
}

async function confirmPurgeMemory(id: string) {
  if (memoryMutating.value || pendingPurgeMemoryId.value !== id || purgePhrase.value.trim() !== '彻底清除') return
  memoryMutating.value = true
  memoryStatusMessage.value = ''
  memoryStatusError.value = false
  try {
    const result = await ipcRenderer.invoke('memory:purge-confirm', {
      id,
      token: purgeToken.value,
      phrase: purgePhrase.value,
    })
    if (!result?.ok) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result?.error || '彻底清除失败。'
      return
    }
    const report = result.report
    memoryStatusMessage.value = `彻底清除完成：V3 已移除，V4 清理 ${report?.purgedEpisodes ?? 0} 条独占证据，残留 ${report?.residualCount ?? 0}。`
    cancelPurgeMemory()
    await refreshMemoryList()
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : '彻底清除失败。'
  }
  finally {
    memoryMutating.value = false
  }
}

async function clearAllMemories() {
  if (!confirmClearMemories.value) {
    confirmClearMemories.value = true
    return
  }
  if (memoryMutating.value) return
  memoryMutating.value = true
  memoryStatusMessage.value = ''
  memoryStatusError.value = false
  try {
    const result = await ipcRenderer.invoke('memory:clear')
    if (!result?.ok) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result?.error || '清空记忆失败。'
      return
    }
    confirmClearMemories.value = false
    memoryStatusMessage.value = 'V3 记忆已普通清空；V4 保留审计墓碑。不可恢复删除请逐条使用“彻底清除”。'
    await refreshMemoryList()
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : '清空记忆失败。'
  }
  finally {
    memoryMutating.value = false
  }
}

async function openMemoryLocation() {
  try {
    const result = await ipcRenderer.invoke('memory:open-location')
    if (result?.ok) return
    memoryStatusError.value = true
    memoryStatusMessage.value = result?.error || '无法打开记忆文件位置。'
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : '无法打开记忆文件位置。'
  }
}

function memoryKindLabel(item: MemoryItem): string {
  const kind = typeof item.metadata?.kind === 'string' ? item.metadata.kind : ''
  return ({
    identity: '身份',
    preference: '偏好',
    project: '项目',
    explicit: '明确记忆',
    manual: '手动添加',
    image: '图片记忆',
  } as Record<string, string>)[kind] || '自动记忆'
}

function memoryStatusLabel(item: MemoryItem): string {
  return ({
    active: '有效',
    superseded: '已被替代',
    expired: '已过期',
    conflicted: '待确认冲突',
    orphaned: '来源已删除',
    suppressed: '已停用',
    deleted: '已删除',
  } as Record<string, string>)[item.status || 'active'] || '有效'
}

function modelProgressLabel(): string {
  const progress = semanticModelProgress.value
  if (progress.status === 'error') return `安装错误：${progress.error || '未知错误'}`
  if (progress.status === 'ready') return '模型就绪'
  if (progress.status === 'verifying')
    return `正在校验模型完整性${typeof progress.checkedFiles === 'number' ? ` · ${progress.checkedFiles} 个文件` : ''}`
  if (progress.status === 'indexing')
    return `正在后台构建语义索引${typeof progress.ready === 'number' && typeof progress.total === 'number' ? ` ${progress.ready}/${progress.total}` : ''}${typeof progress.progress === 'number' ? ` · ${Math.round(progress.progress)}%` : ''}`
  if (progress.status === 'downloading')
    return `下载中${typeof progress.progress === 'number' ? ` ${Math.round(progress.progress)}%` : ''}${progress.file ? ` · ${progress.file}` : ''}`
  if (progress.status === 'loading') return '正在加载模型…'
  return semanticInstalled.value ? '模型已安装' : '尚未安装（聊天仍使用本地哈希检索）'
}

function formatMemoryDate(item: MemoryItem): string {
  const timestamp = item.updatedAt || item.createdAt
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN') : ''
}

// ── Send ────────────────────────────────────────────────
async function send(retryUserId?: string) {
  const retrySource = retryUserId ? messages.value.find(message => message.id === retryUserId && message.role === 'user') : undefined
  const text = retrySource?.content ?? input.value.trim()
  const image = retrySource ? retrySource.retryImage : pendingImage.value
  const reference = retrySource?.quote ?? quotedMessage.value
  const quote = reference ? { ...reference } : undefined
  if ((!text && !image) || isLoading.value || conversationSwitching.value) return
  const sendingConversation = activeConversationId.value
  const skillId = selectedSkillId.value
  pendingConversations.add(sendingConversation)
  isLoading.value = true
  const consumeDraft = !retrySource || (input.value.trim() === text && quotedMessage.value?.messageId === quote?.messageId && !pendingImage.value)
  if (consumeDraft) { input.value = ''; quotedMessage.value = undefined; pendingImage.value = null }
  const prompt = image ? (text || '请描述这个屏幕截图中的内容。') : text
  const userMsg: Message = retrySource ?? { role: 'user', content: prompt, id: crypto.randomUUID(), hasImage: !!image, quote, persisted: false, ...(image ? { retryImage: image } : {}) }
  if (!retrySource) messages.value.push(userMsg)
  const assistantMsg: Message = { role: 'assistant', content: '', id: crypto.randomUUID(), replyTo: userMsg.id }
  messages.value.push(assistantMsg)
  conversationMessages.set(sendingConversation, messages.value)
  scrollToBottom()
  try {
    const attachments = image ? [{ type: 'image' as const, data: image.data, mimeType: image.mimeType }] : undefined
    const result = retrySource?.persisted
      ? await ipcRenderer.invoke('chat:retry', retrySource.id, skillId ? { skillId } : undefined)
      : await ipcRenderer.invoke('chat:send', prompt, attachments, { ...(skillId ? { skillId } : {}), ...(quote ? { quote } : {}) })
    if (!result?.ok) {
      assistantMsg.status = 'failed'
      assistantMsg.content = assistantMsg.content ? `${assistantMsg.content}\n\n请求失败：${result?.error || '未知错误'}` : `请求失败：${result?.error || '未知错误'}`
      if (consumeDraft) restoreFailedDraft(sendingConversation, text, quote)
    } else {
      if (!assistantMsg.content) assistantMsg.content = result.text ?? ''
      if (result.stopped) assistantMsg.status = 'stopped'
    }
    if (result?.memoryReview) assistantMsg.memoryReview = result.memoryReview
    if (result?.userMessageId) { userMsg.id = result.userMessageId; userMsg.persisted = true }
    if (result?.assistantMessageId) assistantMsg.id = result.assistantMessageId
    else if (result?.history) {
      const pair = result.history.filter((h: { role: string }) => h.role === 'user' || h.role === 'assistant').slice(-2)
      if (!retrySource && pair[0]?.role === 'user' && pair[0].content === prompt) { userMsg.id = pair[0].id; userMsg.persisted = true }
      if (pair[1]?.role === 'assistant') assistantMsg.id = pair[1].id
    }
    assistantMsg.replyTo = userMsg.id
    if (!result?.stopped && result?.ok && autoSpeak.value && sendingConversation === activeConversationId.value) nextTick(() => speak(assistantMsg.content))
  } catch (error) {
    assistantMsg.status = 'failed'; assistantMsg.content = `请求失败：${error instanceof Error ? error.message : '未知错误'}`
    if (consumeDraft) restoreFailedDraft(sendingConversation, text, quote)
  } finally {
    pendingConversations.delete(sendingConversation); stoppingConversations.value.delete(sendingConversation)
    if (sendingConversation === activeConversationId.value) {
      isLoading.value = false
      await refreshMemoryStatus()
      void refreshMemoryActivity().catch(() => {})
      scrollToBottom(false)
    }
  }
}

function restoreFailedDraft(id: string, text: string, quote?: MessageQuote) {
  if (id === activeConversationId.value && !input.value && !quotedMessage.value) { input.value = text; quotedMessage.value = quote }
  else if (id !== activeConversationId.value) draftStorage.queue(id, { ...draftStorage.get(id), text, ...(quote ? { quote } : {}) })
}

// ── Rollback ────────────────────────────────────────────
async function rollback(msgId: string) {
  if (isLoading.value) return
  const idx = messages.value.findIndex(m => m.id === msgId)
  if (idx < 0) return
  await ipcRenderer.invoke('sessions:truncate-after', msgId)
  const removed = messages.value.splice(idx)
  if (removed.some(message => message.id === quotedMessage.value?.messageId)) quotedMessage.value = undefined
}

// ── Screen capture (识屏) ───────────────────────────────
async function captureScreen() {
  if (isCapturing.value || isLoading.value) return
  isCapturing.value = true
  try {
    const result = await ipcRenderer.invoke('screen:capture')
    if (result.ok) {
      pendingImage.value = { data: result.data, mimeType: result.mimeType }
    }
    else {
      console.error('[continuum-memory] screen capture failed:', result.error)
    }
  }
  catch (err) {
    console.error('[continuum-memory] screen capture error:', err)
  }
  finally {
    isCapturing.value = false
  }
}

function clearPendingImage() {
  pendingImage.value = null
}

// ── Voice input / STT (语音输入 — Vosk 离线) ──────────
async function toggleListening() {
  if (isListening.value)
    await stopListening()
  else
    await startListening()
}

async function ensureVoiceSetup(): Promise<boolean> {
  if (voiceSetup.value === 'ready') return true
  voiceSetup.value = 'checking'
  voiceError.value = '检查语音环境...'
  const check = await ipcRenderer.invoke('voice:check-model')
  if (check.modelExists && check.pythonOk && check.voskOk && check.scriptExists) {
    voiceSetup.value = 'ready'
    voiceError.value = ''
    return true
  }
  voiceSetup.value = 'installing'
  voiceError.value = '正在安装语音识别组件（首次需要1-2分钟）...'
  try {
    await ipcRenderer.invoke('voice:setup')
    voiceSetup.value = 'ready'
    voiceError.value = ''
    return true
  }
  catch (err) {
    voiceSetup.value = 'needed'
    voiceError.value = '语音识别安装失败: ' + (err instanceof Error ? err.message : '未知错误')
    setTimeout(() => { voiceError.value = '' }, 5000)
    return false
  }
}

async function startListening() {
  voiceError.value = ''
  const ready = await ensureVoiceSetup()
  if (!ready) return

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000 } })
    audioChunks = []
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data)
    }
    mediaRecorder.start()
    isListening.value = true
  }
  catch (err) {
    voiceError.value = '麦克风访问失败: ' + (err instanceof Error ? err.message : '未知错误')
    setTimeout(() => { voiceError.value = '' }, 3000)
  }
}

async function stopListening() {
  isListening.value = false
  if (!mediaRecorder) return

  const recorder = mediaRecorder
  mediaRecorder = null

  voiceError.value = '识别中...'
  await new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
    recorder.stop()
    recorder.stream.getTracks().forEach(t => t.stop())
  })

  if (audioChunks.length === 0) {
    voiceError.value = ''
    return
  }

  const blob = new Blob(audioChunks, { type: 'audio/webm' })
  audioChunks = []
  try {
    const arrayBuffer = await blob.arrayBuffer()
    const audioContext = new AudioContext({ sampleRate: 16000 })
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
    const wavBuffer = audioBufferToWav(audioBuffer)
    audioContext.close()

    const result = await ipcRenderer.invoke('voice:transcribe', wavBuffer)
    if (result.ok && result.text) {
      input.value = result.text
    }
    else if (!result.ok) {
      voiceError.value = result.error || '识别失败'
      setTimeout(() => { voiceError.value = '' }, 3000)
    }
  }
  catch (err) {
    voiceError.value = '音频处理失败: ' + (err instanceof Error ? err.message : '未知错误')
    setTimeout(() => { voiceError.value = '' }, 3000)
  }
  finally {
    voiceError.value = ''
  }
}

function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = 1
  const sampleRate = buffer.sampleRate
  const samples = buffer.getChannelData(0)
  const dataSize = samples.length * 2
  const arrayBuffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(arrayBuffer)
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true)
    offset += 2
  }
  return arrayBuffer
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++)
    view.setUint8(offset + i, str.charCodeAt(i))
}

// ── Voice output / TTS (语音播报) ───────────────────────
function speak(text: string) {
  if (!text || !autoSpeak.value) return
  speechSynthesis.cancel()
  const utter = new SpeechSynthesisUtterance(text)
  utter.lang = 'zh-CN'
  utter.rate = 1.0
  speechSynthesis.speak(utter)
}

function toggleAutoSpeak() {
  autoSpeak.value = !autoSpeak.value
  if (!autoSpeak.value) speechSynthesis.cancel()
}

// ── Theme ───────────────────────────────────────────────
function closeThemeMenu(restorePreview: boolean) {
  if (restorePreview && themePreviewOrigin)
    currentTheme.value = themePreviewOrigin
  themePreviewOrigin = null
  showThemeMenu.value = false
}

function v4FeedbackKey(reviewId: string, factId?: string): string {
  return `${reviewId}:${factId || '__missing__'}`
}

function v4FeedbackGateLabel(): string {
  const calibration = memoryV4FeedbackCalibration.value
  if (!calibration || calibration.error)
    return calibration?.error ? `校准状态错误：${calibration.error}` : '尚无反馈校准数据'
  const gate = calibration.gate
  const calibrationSamples = Number(calibration.calibrationStats?.samples) || 0
  const validationSamples = Number(calibration.validationStats?.samples) || 0
  const decision = gate?.decision === 'eligible-for-offline-fit'
    ? '可进行离线拟合'
    : gate?.decision === 'blocked'
      ? '质量门禁阻止'
      : '数据不足'
  return `反馈冻结集：校准 ${calibrationSamples} / 验证 ${validationSamples}；${decision}，不影响在线排序`
}

async function submitV4InternalFeedback(
  reviewId: string,
  factId: string | undefined,
  label: MemoryV4InternalFeedbackLabel,
) {
  const key = v4FeedbackKey(reviewId, factId)
  if (v4InternalFeedbackPending.value)
    return
  v4InternalFeedbackPending.value = key
  v4InternalFeedbackError.value[key] = ''
  try {
    const result = await ipcRenderer.invoke('memory:v4-internal-feedback', {
      reviewId,
      ...(factId ? { factId } : {}),
      label,
    })
    if (!result?.ok) {
      v4InternalFeedbackError.value[key] = result?.error || '反馈保存失败。'
      return
    }
    v4InternalFeedback.value[key] = label
  }
  catch (error) {
    v4InternalFeedbackError.value[key] = error instanceof Error ? error.message : '反馈保存失败。'
  }
  finally {
    v4InternalFeedbackPending.value = ''
  }
}

function toggleThemeMenu() {
  if (showThemeMenu.value) {
    closeThemeMenu(true)
    return
  }
  themePreviewOrigin = currentTheme.value
  showThemeMenu.value = true
}

async function selectTheme(t: Theme) {
  currentTheme.value = t
  closeThemeMenu(false)
  await ipcRenderer.invoke('settings:set-theme', t.id)
}

function previewCustomTheme() {
  currentTheme.value = createCustomTheme(customColor.value)
}

async function applyCustomTheme() {
  currentTheme.value = createCustomTheme(customColor.value)
  closeThemeMenu(false)
  await ipcRenderer.invoke('settings:set-theme', `${CUSTOM_THEME_PREFIX}${customColor.value.toLowerCase()}`)
}

function dismissHeaderMenus(event: PointerEvent) {
  const target = event.target
  if (!(target instanceof Element)) return
  if (!target.closest('.theme-picker')) closeThemeMenu(true)
  if (!target.closest('.header-menu')) showAppMenu.value = false
  if (!target.closest('.input-more-wrap')) showInputMenu.value = false
}
function onHeaderEscape(event: KeyboardEvent) {
  if (event.defaultPrevented || event.key !== 'Escape') return
  if (showThemeMenu.value) closeThemeMenu(true)
  showAppMenu.value = false
}
function beginRename() {
  conversationRenameInput.value = currentConversationTitle.value
  renamingConversation.value = true
  showAppMenu.value = false
  nextTick(() => document.querySelector<HTMLInputElement>('.conversation-meta input')?.focus())
}

// ── Utils ───────────────────────────────────────────────
function scrollToBottom(force = true) {
  if (force) { followLatest.value = true; manualChatScroll = false; unreadReply.value = false }
  if (!followLatest.value) return
  nextTick(() => {
    const el = chatEl.value
    if (el && followLatest.value) { el.scrollTop = el.scrollHeight; unreadReply.value = false }
  })
}

function onKeydown(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return
  const shouldSend = preferences.value.sendKey === 'ctrl-enter' ? (e.ctrlKey || e.metaKey) && !e.shiftKey : !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
  if (e.key === 'Enter' && shouldSend) {
    e.preventDefault()
    send()
  }
}

const confirmReset = ref(false)
async function doReset() {
  if (!confirmReset.value) {
    confirmReset.value = true
    resetTimer = setTimeout(() => { confirmReset.value = false }, 3000)
    return
  }
  await ipcRenderer.invoke('app:reset')
}
</script>

<template>
  <!-- Loading state -->
  <div v-if="!loaded" class="loading">
    <div class="spinner" />
  </div>

  <!-- First-run naming screen -->
  <div v-else-if="isFirstRun" class="setup" :style="themeVars">
    <div class="setup-card">
      <MemoryMark class="setup-brand-icon" />
      <h1>欢迎使用 Continuum Memory</h1>
      <span v-if="appVersion" class="setup-version">v{{ appVersion }}</span>
      <p>给你的 AI 智能体取个名字吧</p>
      <input v-model="nameInput" placeholder="输入名字..." @keydown.enter="confirmName" autofocus />
      <button :disabled="!nameInput.trim()" @click="confirmName">确认</button>
    </div>
  </div>

  <!-- Chat screen -->
  <div v-else class="app" :data-window-visible="windowVisible" :style="{ ...themeVars, ...readerStyle }" :data-theme="currentTheme.id" :data-family="currentTheme.family ?? 'warm'" :data-scheme="currentTheme.scheme ?? 'light'">
    <header class="header">
      <div class="header-heading"><span class="name">{{ currentConversationTitle }}</span><span v-if="currentArchived" class="archive-label">已归档</span><span class="header-eyebrow"><span class="space-node" />独立记忆空间</span></div>
      <div class="header-actions">
        <button class="memory-activity-pill" :class="{ working: memoryActivity.totals.processing || memoryActivity.totals.pending, warning: memoryActivity.totals.failed || memoryActivity.totals.clarifying }" aria-label="记忆处理状态" :title="memoryActivitySummary" @click="showMemoryActivity = true; refreshMemoryActivity()"><AppIcon name="memory" /><span>{{ memoryActivitySummary }}</span></button>
        <button class="api-btn" :class="{ active: apiConfigured }" title="API 设置" aria-label="API 设置" @click="openApiSettings"><span class="api-dot" /><span class="api-label">{{ apiConfigured ? 'API 已配置' : '配置 API' }}</span></button>
        <div class="theme-picker">
          <button class="icon-btn" title="切换主题" aria-label="切换主题" :aria-expanded="showThemeMenu" @click="toggleThemeMenu"><AppIcon name="sun" /></button>
          <div v-if="showThemeMenu" class="theme-menu" aria-label="界面主题">
            <div class="theme-menu-title">选择你的工作空间</div>
            <template v-for="family in ['warm', 'tech']" :key="family">
              <div class="theme-group-label">{{ family === 'warm' ? '记忆织线 · 温暖质感' : '记忆网络 · 科技感' }}</div>
              <button v-for="t in themes.filter(theme => theme.family === family)" :key="t.id" :data-theme-option="t.id" :class="['theme-item', { active: t.id === currentTheme.id }]" :aria-pressed="t.id === currentTheme.id" @click="selectTheme(t)">
                <MemoryMark :theme="t.id" class="theme-option-icon" /><span>{{ t.name }}</span><span v-if="t.id === currentTheme.id" class="theme-check">✓</span>
              </button>
            </template>
            <div :class="['theme-custom', { active: currentTheme.id === 'custom' }]">
              <label for="custom-theme-color">自定义颜色</label>
              <div class="theme-custom-controls"><input id="custom-theme-color" v-model="customColor" type="color" title="选择自定义颜色" @input="previewCustomTheme" /><span>{{ customColor.toUpperCase() }}</span><button type="button" @click="applyCustomTheme">应用</button></div>
              <small>自动生成明亮背景并保持文字清晰</small>
            </div>
          </div>
        </div>
        <div class="header-menu">
          <button class="icon-btn" title="更多操作" aria-label="更多操作" :aria-expanded="showAppMenu" @click="showAppMenu = !showAppMenu; closeThemeMenu(true)"><AppIcon name="more" /></button>
          <div v-if="showAppMenu" class="app-menu">
            <button @click="openApiSettings(); showAppMenu = false"><AppIcon name="settings" />API 设置</button>
            <button :class="{ selected: autoSpeak }" @click="toggleAutoSpeak(); showAppMenu = false"><AppIcon name="volume" />{{ autoSpeak ? '关闭语音播报' : '开启语音播报' }}</button>
            <button :disabled="!canSwitchConversation" @click="beginRename"><AppIcon name="rename" />重命名当前对话</button>
            <button @click="pinConversation(activeConversationId, !conversations.find(c => c.id === activeConversationId)?.pinned); showAppMenu = false"><AppIcon name="pin" />{{ conversations.find(c => c.id === activeConversationId)?.pinned ? '取消置顶当前对话' : '置顶当前对话' }}</button>
            <button :disabled="isLoading || exportingConversation" @click="exportConversation('md')"><AppIcon name="export" />导出 Markdown</button>
            <button :disabled="isLoading || exportingConversation" @click="exportConversation('txt')"><AppIcon name="export" />导出 TXT</button>
            <button @click="archiveConversation(activeConversationId, !currentArchived); showAppMenu = false"><AppIcon name="archive" />{{ currentArchived ? '恢复当前对话' : '归档当前对话' }}</button>
            <button @click="showArchiveLibrary = true; showAppMenu = false"><AppIcon name="archive" />归档对话</button>
            <button :disabled="!canSwitchConversation" class="menu-delete-conversation" @click="requestConversationDelete(conversations.find(c => c.id === activeConversationId)!)"><AppIcon name="trash" />删除当前对话…</button>
            <button @click="openGeneralSettings"><AppIcon name="settings" />通用设置</button>
            <button @click="doReset"><AppIcon name="reset" />{{ confirmReset ? '再次点击确认重置' : '重新开始' }}</button>
          </div>
        </div>
      </div>
    </header>

    <ConversationDelete v-if="pendingConversationDelete" :title="pendingConversationDelete.title" :busy="conversationDeleteBusy" :error="conversationDeleteError" @close="pendingConversationDelete = null" @confirm="confirmConversationDelete" />
    <GeneralSettings v-if="showGeneralSettings" :preferences="preferences" :busy="generalSettingsBusy" :error="generalSettingsError" @close="closeGeneralSettings" @preview="readerPreview = $event" @save="saveGeneralSettings" />
    <ComposerEditor v-if="showComposerEditor" v-model="input" :selection="editorSelection" :disabled="isLoading || conversationSwitching" @close="closeComposerEditor" @send="closeComposerEditor($event, true)" />
    <SavedMessages v-if="showSavedMessages" :items="bookmarks" :disabled="!canSwitchConversation" @close="showSavedMessages = false" @open="openSavedMessage" @remove="toggleBookmark($event.conversationId, $event.messageId, false)" @notice="notifyChat" />
    <MemoryActivity v-if="showMemoryActivity" :report="memoryActivity" :loading="memoryActivityLoading" @close="showMemoryActivity = false" @refresh="refreshMemoryActivity" @review="showMemoryActivity = false; openMemoryManager()" />
    <ConversationSearch v-if="showArchiveLibrary" :conversations="conversations" :archived-only="true" :disabled="!canSwitchConversation" @close="showArchiveLibrary = false" @select="openSearchResult($event); showArchiveLibrary = false" @pin="pinConversation" @archive="archiveConversation" @delete="requestConversationDelete" />
    <ConversationSearch v-if="showConversationSearch" :conversations="conversations" :disabled="!canSwitchConversation" @close="showConversationSearch = false" @select="openSearchResult" @pin="pinConversation" @archive="archiveConversation" @delete="requestConversationDelete" />
    <QuickPhrases v-if="showQuickPhrases" :phrases="quickPhrases" :disabled="isLoading || conversationSwitching" @close="showQuickPhrases = false" @insert="insertPhrase" @updated="quickPhrases = $event" />
    <div v-if="chatNotice" class="chat-toast" role="status">{{ chatNotice }}</div>
    <aside class="conversation-bar" aria-label="对话与工具">
      <div class="sidebar-brand"><MemoryMark class="brand-mark" /><div><strong>Continuum<span>Memory</span></strong><small v-if="agentName !== 'Continuum Memory'">{{ agentName }}</small></div></div>
      <button class="sidebar-search-button" aria-label="搜索对话" :title="`搜索对话（${preferences.shortcuts.search}）`" @click="showConversationSearch = true"><AppIcon name="search" /><span class="nav-label">搜索对话</span><kbd>{{ preferences.shortcuts.search.replace(/\+/g, ' ') }}</kbd></button>
      <button class="new-conversation" title="新建对话" aria-label="新建对话" :disabled="!canSwitchConversation" @click="selectConversation()"><span class="new-conversation-medallion"><AppIcon name="plus" /></span><span class="nav-label">新建对话</span></button>
      <nav class="sidebar-tools" aria-label="工作空间">
        <button title="长期记忆管理" aria-label="长期记忆管理" @click="openMemoryManager"><AppIcon name="memory" /><span class="nav-label">记忆库</span><span class="sidebar-tool-count">{{ memoryL1Count ?? '…' }}</span></button>
        <button title="Skill 管理" aria-label="Skill 管理" @click="openSkillManager"><AppIcon name="skill" /><span class="nav-label">Skill</span></button>
        <button title="收藏消息" aria-label="收藏消息" @click="showSavedMessages = true; refreshBookmarks()"><AppIcon name="bookmark" /><span class="nav-label">收藏</span><span v-if="bookmarks.length" class="sidebar-tool-count">{{ bookmarks.length }}</span></button>
        <button title="文档" aria-label="文档" :disabled="documentsBusy" @click="openDocumentManager"><AppIcon name="document" /><span class="nav-label">文档</span></button>
      </nav>
      <section class="sidebar-history" aria-label="历史对话">
        <div class="sidebar-history-heading"><span>历史对话</span><span class="sidebar-history-count">{{ orderedConversations.length }}</span><button class="sidebar-history-action" title="查看归档" aria-label="查看归档" @click="showArchiveLibrary = true"><AppIcon name="archive" /></button></div>
        <nav class="conversation-list" aria-label="对话列表">
          <div v-for="conversation in orderedConversations" :key="conversation.id" class="conversation-entry">
          <button class="conversation-item"
            :class="{ selected: conversation.id === activeConversationId }" :aria-current="conversation.id === activeConversationId ? 'page' : undefined"
            :title="conversation.title" :aria-label="conversation.title" :disabled="!canSwitchConversation" @click="conversation.id !== activeConversationId && selectConversation(conversation.id)">
            <AppIcon name="chat" class="conversation-icon" /><span class="conversation-copy"><span class="conversation-title">{{ conversation.title }}</span><small v-if="conversation.id === activeConversationId" title="当前对话拥有独立记忆空间">独立记忆空间</small></span>
          </button>
          <button class="conversation-delete-action" :disabled="!canSwitchConversation" :aria-label="`删除对话：${conversation.title}`" title="删除对话" @click="requestConversationDelete(conversation)"><AppIcon name="trash" /></button>
          <button class="conversation-pin" :class="{ pinned: conversation.pinned }" :disabled="!!pinningConversation" :aria-label="`${conversation.pinned ? '取消置顶' : '置顶'}：${conversation.title}`" :title="conversation.pinned ? '取消置顶' : '置顶对话'" :aria-pressed="!!conversation.pinned" @click="pinConversation(conversation.id, !conversation.pinned)"><AppIcon name="pin" /></button>
          </div>
        </nav>
        <div class="conversation-meta" :class="{ 'is-renaming': renamingConversation }">
          <button v-if="!renamingConversation" class="rename-conversation" :disabled="!canSwitchConversation" @click="beginRename"><AppIcon name="rename" /><span class="nav-label">重命名当前对话</span></button>
          <template v-else>
            <input v-model="conversationRenameInput" aria-label="对话名称" maxlength="100" @keydown.enter="renameConversation" />
            <button class="secondary-btn" :disabled="!conversationRenameInput.trim()" @click="renameConversation">保存名称</button>
            <button class="secondary-btn" @click="renamingConversation = false">取消</button>
          </template>
          <span>{{ conversationSwitching ? '正在切换…' : '每段对话拥有独立记忆' }}</span>
        </div>
      </section>
      <div class="sidebar-footer"><button title="设置" aria-label="通用设置" @click="openGeneralSettings"><AppIcon name="settings" /><span class="nav-label">设置</span></button><small class="nav-label" v-if="appVersion">v{{ appVersion }}</small></div>
    </aside>
    <div v-if="conversationError" class="conversation-error">{{ conversationError }}</div>

    <div v-if="showSkillManager" class="modal-backdrop" @pointerdown.self.prevent>
      <div v-dialog-focus="closeSkillManager" class="skill-dialog" role="dialog" aria-modal="true" aria-label="Skill 管理">
        <div class="dialog-header">
          <div><h2>Skill 管理</h2><p>内置工作流与本机 SKILL.md · {{ enabledSkills.length }} 个已启用</p></div>
          <button class="dialog-close" title="关闭" :disabled="skillsBusy" @click="closeSkillManager">✕</button>
        </div>
        <p class="field-hint">模型可以按任务查找并加载已启用 Skill，也可以在输入框右侧手动选择。加载的是工作流指导；本机 Skill 默认关闭，需要专用工具的项目会显示缺少依赖。</p>
        <p class="field-hint">调用时，选中的工作流及所需文本引用会发送给当前聊天 API；不会一次发送全部 Skill 文件。</p>
        <div class="skill-toolbar">
          <input v-model="skillQuery" class="settings-input" aria-label="搜索 Skill" placeholder="搜索名称、用途或依赖…" />
          <button class="secondary-btn" :disabled="skillsBusy" @click="scanSkills()">重新扫描</button>
          <button class="secondary-btn" :disabled="skillsBusy" @click="scanSkills(true)">添加本地目录</button>
        </div>
        <div v-if="skillStatusMessage" class="api-status-message">{{ skillStatusMessage }}</div>
        <details v-if="skillWarnings.length" class="field-hint"><summary>扫描提示（{{ skillWarnings.length }}）</summary><p v-for="warning in skillWarnings" :key="warning">{{ warning }}</p></details>
        <div v-if="!filteredSkills.length" class="memory-empty">没有匹配的 Skill。</div>
        <article v-for="skill in filteredSkills" :key="skill.id" class="skill-card">
          <div class="skill-card-title"><strong>{{ skill.name }}</strong><span>{{ skill.source === 'builtin' ? '内置' : '本机' }}</span>
            <label><input type="checkbox" :checked="skill.enabled" :disabled="skillsBusy || !skill.available" :aria-label="`启用 ${skill.name}`" @change="changeSkill(skill.id, ($event.target as HTMLInputElement).checked)" /> 启用</label>
          </div>
          <p>{{ skill.description }}</p>
          <div class="field-hint">{{ skill.reason }}</div>
          <div v-if="skill.path" class="skill-path" :title="skill.path">{{ skill.path }}</div>
          <button class="secondary-btn" @click="previewSkill(skill.id)">查看工作流</button>
          <button v-if="skill.available && skill.enabled" class="secondary-btn" @click="selectedSkillId = skill.id; closeSkillManager()">用于当前对话</button>
          <button v-if="skill.replacementId && enabledSkills.some(item => item.id === skill.replacementId)" class="secondary-btn" @click="selectedSkillId = skill.replacementId; closeSkillManager()">使用桌面适配版</button>
          <pre v-if="skillPreview?.id === skill.id" class="skill-preview">{{ skillPreview.instructions }}{{ skillPreview.truncated ? '\n（预览已截断）' : '' }}</pre>
        </article>
        <details v-if="skillUseHistory.length" class="memory-section"><summary>当前对话最近加载记录</summary>
          <p v-for="(event, index) in skillUseHistory.slice().reverse().slice(0, 10)" :key="index" class="field-hint">{{ event.name }} · {{ event.mode === 'model' ? '模型调用' : '手动选择' }} · {{ new Date(event.at).toLocaleTimeString() }}</p>
        </details>
      </div>
    </div>

    <div v-if="showDocumentManager" class="modal-backdrop" @pointerdown.self.prevent>
      <div v-dialog-focus="closeDocumentManager" class="skill-dialog" role="dialog" aria-modal="true" aria-label="文档管理">
        <div class="dialog-header"><div><h2>PDF 与 Word 文档</h2><p>当前分区：{{ currentConversationTitle }}</p></div>
          <button class="dialog-close" title="关闭" :disabled="documentsBusy" @click="closeDocumentManager">✕</button>
        </div>
        <p class="field-hint">选择 PDF / DOCX 后，可以在聊天中要求读取、总结或生成新文档。文件只登记到当前对话；提出任务后，所需文本才会由工具发送给当前 API。文件按原格式保存，不属于加密记忆正文。</p>
        <div class="skill-toolbar"><button class="secondary-btn" :disabled="documentsBusy" @click="pickDocuments">选择 PDF / Word 文件</button>
          <span class="field-hint">PDF {{ documentRuntime?.pdf ? '可用' : '不可用' }} · Word {{ documentRuntime?.word ? '可用' : '不可用' }}</span>
        </div>
        <div v-if="documentRuntime?.error" class="api-status-message error">{{ documentRuntime.error }}</div>
        <div v-if="documentMessage" class="api-status-message">{{ documentMessage }}</div>
        <p v-if="!documentItems.length" class="memory-empty">暂无文档。可以选择文件，或选择 PDF / Word Skill 后在聊天中要求生成。</p>
        <article v-for="file in documentItems" :key="file.id" class="skill-card">
          <div class="skill-card-title"><strong>{{ file.name }}</strong><span>{{ file.kind === 'input' ? '已选文件' : '生成结果' }} · {{ file.format.toUpperCase() }}</span></div>
          <button class="secondary-btn" :disabled="documentsBusy" @click="inspectDocument(file.id)">{{ file.format === 'pdf' ? '页面预览' : '结构预览' }}</button>
          <button class="secondary-btn" @click="openDocument(file.id)">打开文件</button>
          <button class="secondary-btn" @click="openDocument(file.id, true)">查看文件位置</button>
        </article>
        <section v-if="documentPreview" class="document-preview">
          <h3>{{ documentPreview.name || '文档预览' }}</h3><p class="field-hint">{{ documentPreview.notice }}</p>
          <img v-for="url in documentPreview.images" :key="url" :src="url" alt="PDF 页面预览" />
          <div v-for="(block, index) in documentPreview.blocks" :key="index">
            <h4 v-if="block.type === 'heading'">{{ block.text }}</h4>
            <table v-else-if="block.type === 'table'"><tbody><tr v-for="(row, rowIndex) in block.rows" :key="rowIndex"><td v-for="(cell, cellIndex) in row" :key="cellIndex">{{ cell }}</td></tr></tbody></table>
            <p v-else>{{ block.text }}</p>
          </div>
        </section>
      </div>
    </div>
    <!-- API settings dialog -->
    <div v-if="showApiSettings" class="modal-backdrop" @pointerdown.self.prevent>
      <div v-dialog-focus="closeApiSettings" class="api-dialog" role="dialog" aria-modal="true" aria-label="API 设置">
        <div class="dialog-header">
          <div>
            <h2>API 设置</h2>
            <p>保存后立即生效；关闭面板会保留本次未保存输入</p>
          </div>
          <button class="dialog-close" :disabled="apiSaving" title="关闭" @click="closeApiSettings">✕</button>
        </div>

        <label class="field-label" for="api-key">API Key</label>
        <input
          id="api-key"
          data-dialog-autofocus
          v-model="apiKeyInput"
          class="settings-input"
          type="password"
          autocomplete="off"
          spellcheck="false"
          :placeholder="apiConfigured ? '已配置；留空可保持原密钥' : '请输入 API Key'"
        />
        <div class="field-hint">密钥不会在界面中回显，并使用系统加密存储。</div>

        <label class="field-label" for="api-base-url">Base URL</label>
        <input id="api-base-url" v-model="apiBaseURL" class="settings-input" type="url" spellcheck="false" placeholder="https://api.openai.com/v1" />

        <label class="field-label" for="api-model">模型名称</label>
        <input id="api-model" v-model="apiModel" class="settings-input" type="text" spellcheck="false" placeholder="gpt-4o-mini" />
        <div class="field-hint">点击背景不会关闭面板。请点击“保存配置”提交；Esc 或关闭按钮只收起面板。未保存输入仅在本次运行期间保留。</div>

        <div v-if="apiStatusMessage" :class="['api-status-message', { error: apiStatusError }]">{{ apiStatusMessage }}</div>

        <div class="dialog-actions">
          <span :class="['configured-state', { ready: apiConfigured }]">{{ apiConfigured ? '● 已配置' : '○ 未配置' }}</span>
          <span class="dialog-spacer" />
          <button class="secondary-btn" :disabled="apiSaving" @click="restoreApiDraft">恢复已保存配置</button>
          <button class="secondary-btn" :disabled="apiSaving" @click="closeApiSettings">关闭（保留输入）</button>
          <button class="primary-btn" :disabled="apiSaving" @click="saveApiSettings">{{ apiSaving ? '保存中...' : '保存配置' }}</button>
        </div>
      </div>
    </div>

    <!-- Long-term memory manager dialog -->
    <div v-if="showMemoryManager" class="modal-backdrop" @pointerdown.self.prevent>
      <div v-dialog-focus="closeMemoryManager" class="memory-dialog" role="dialog" aria-modal="true" aria-label="长期记忆管理">
        <div class="dialog-header">
          <div>
            <h2>长期记忆管理</h2>
            <p>当前分区：{{ currentConversationTitle }} · 本页操作仅作用于此对话的记忆</p>
          </div>
          <button class="dialog-close" :disabled="memoryMutating" title="关闭" @click="closeMemoryManager">✕</button>
        </div>

        <div class="memory-summary">
          <span :class="['configured-state', { ready: memoryEnabled }]">
            {{ memoryEnabled ? '● 长期记忆已启用' : '○ 长期记忆已关闭' }}
          </span>
          <span class="dialog-spacer" />
          <button class="secondary-btn" :disabled="memoryLoading" @click="refreshMemoryList">{{ memoryLoading ? '读取中...' : '刷新' }}</button>
          <button class="secondary-btn" @click="openMemoryLocation">打开文件位置</button>
        </div>

        <div class="memory-overview" aria-label="记忆分类统计">
          <div><span>正式事实 · L1</span><strong>{{ memoryL1Count ?? '…' }}</strong><small>已发布的结构化事实</small></div>
          <div><span>传统记忆</span><strong>{{ memoryCount }}</strong><small>偏好等可编辑记忆条目</small></div>
          <div><span>原文来源</span><strong>{{ captureStatus?.activeSources ?? '…' }}</strong><small>独立保存的原始信息</small></div>
        </div>
        <p class="field-hint">三类数量分别统计，不可相加。原文保存、事实发布和聊天使用权限各自独立。</p>
        <MemoryRecallNotice :enabled="memorySettings.openSourceRecallEnabled" :memory-enabled="memoryEnabled"
          :remote-policy="memorySettings.remotePolicy" :busy="memoryMutating"
          @enable="saveMemorySettings({ openSourceRecallEnabled: true })" />
        <section class="memory-section">
          <h3>正式事实与证据</h3>
          <p class="field-hint">L1 保留原文中的关系、参与对象与语境。发布表示通过准入审核，仍需结合来源理解。</p>
          <div v-if="!graphClaimItems.length" class="field-hint">{{ memoryLoading ? '正在读取正式事实…' : '当前没有可展示的正式事实。已保存的原文和传统记忆可在下方查看。' }}</div>
        <details v-if="graphClaimItems.length" class="formal-claims" open>
          <summary>最近的正式事实 · {{ graphClaimItems.length }} 条</summary>
          <article v-for="claim in (showAllFormalClaims ? graphClaimItems : graphClaimItems.slice(0, 5))" :key="claim.id" class="memory-item">
            <div class="memory-item-main">
              <div class="memory-item-meta"><span class="memory-kind">{{ claim.relation }}</span><span>正式事实 · L1</span></div>
              <dl class="memory-fact-fields">
                <div v-for="(arg, index) in claim.arguments" :key="index"><dt :title="arg.role">{{ memoryRoleLabels[arg.role] ?? arg.role }}</dt><dd>{{ arg.text }}</dd></div>
              </dl>
              <div class="memory-context-tags">
                <span>{{ claim.polarity === 'negative' ? '否定' : claim.polarity === 'positive' ? '肯定' : '肯定 / 否定未明确' }}</span>
                <span>{{ { asserted: '陈述', planned: '计划', reported: '转述', hypothetical: '假设', unknown: '陈述方式未明确' }[claim.modality] ?? claim.modality }}</span>
                <span>时间：{{ claim.time === 'unknown' || !claim.time ? '未明确' : claim.time === 'none' ? '无时间限定' : claim.time }}</span>
              </div>
              <details class="memory-review-evidence">
                <summary>查看原文证据{{ claim.supplementalEvidence.length ? '与补充信息' : '' }}</summary>
                <blockquote>{{ claim.sourceText || '原文暂不可用' }}</blockquote>
                <div v-for="extra in claim.supplementalEvidence" :key="extra.sourceId">补充证据：{{ extra.text }}</div>
              </details>
            </div>
          </article>
          <button v-if="graphClaimItems.length > 5" class="secondary-btn memory-more-btn" :aria-expanded="showAllFormalClaims" @click="showAllFormalClaims = !showAllFormalClaims">
            {{ showAllFormalClaims ? '收起，仅显示最近 5 条' : `查看其余 ${graphClaimItems.length - 5} 条` }}
          </button>
        </details>
        </section>
        <div v-if="memoryStatusMessage" :class="['api-status-message', { error: memoryStatusError }]">{{ memoryStatusMessage }}</div>
        <div v-if="graphExtractionStatus?.error" class="api-status-message error">最近一次提取失败：{{ graphExtractionStatus.error }}</div>
        <details v-if="graphInformationItems.length" class="memory-section memory-source-list">
          <summary>原文来源 · 最近 {{ graphInformationItems.length }} 条</summary>
          <p class="field-hint">保存的是原始信息；是否发布为正式事实、是否允许用于聊天，由各自的规则决定。</p>
          <article v-for="item in graphInformationItems" :key="item.id" class="memory-item">
            <div class="memory-content">{{ item.text }}</div>
          </article>
        </details>
        <GraphOpenAssertions :conversation-id="activeConversationId" :ready="!!graphL1View" :busy="memoryMutating" :items="graphOpenAssertionItems"
          :sources="graphInformationItems" @refresh="refreshMemoryList" @busy="memoryMutating = $event" />

        <div class="field-hint">本地开放记录搜索与聊天原文召回是不同路径。开启原文召回并允许远程记忆发送后，获准来源可沿开放关系参与聊天；发送的是原文而不是图推导结论。关闭时使用正式事实的图检索。</div>

        <details class="memory-settings-panel">
          <summary class="memory-settings-title">
            <strong>提取与使用设置</strong>
            <span :class="['memory-encryption-state', { ready: memoryEncrypted }]">{{ memoryEncrypted ? '🔒 已加密存储' : '⚠ 加密存储不可用' }}</span>
          </summary>
          <h4 class="memory-subheading">提取方式与发送权限</h4>
          <div class="memory-settings-grid">
            <label>
              <span>提取方式</span>
              <select v-model="memorySettings.extractionMode" :disabled="memoryMutating" @change="saveMemorySettings({ extractionMode: memorySettings.extractionMode })">
                <option value="rules">本地规则 + UIE 候选</option>
                <option value="open">开放关系优先 · 当前 API</option>
                <option value="smart">开放关系 + 智能记忆 · 当前 API</option>
                <option value="uie">本地 UIE · 保存图候选</option>
              </select>
            </label>
            <label>
              <span>发送给聊天模型</span>
              <select v-model="memorySettings.remotePolicy" :disabled="memoryMutating" @change="saveMemorySettings({ remotePolicy: memorySettings.remotePolicy })">
                <option value="normal-only">仅普通且允许分享</option>
                <option value="allow-private">允许已授权的隐私记忆</option>
                <option value="disabled">完全不发送长期记忆</option>
              </select>
            </label>
          </div>
          <h4 class="memory-subheading">补充提取</h4>
          <label class="memory-check-row">
            <input v-model="memorySettings.uieSupplementEnabled" type="checkbox" :disabled="memoryMutating || memorySettings.extractionMode === 'uie'" @change="saveMemorySettings({ uieSupplementEnabled: memorySettings.uieSupplementEnabled })" />
            <span>使用本地 UIE 补充领域信息（开放关系保存不依赖此项）</span>
          </label>
          <label class="memory-check-row">
            <input v-model="memorySettings.graphExtractionEnabled" type="checkbox" :disabled="memoryMutating || memorySettings.extractionMode === 'uie'" @change="saveMemorySettings({ graphExtractionEnabled: memorySettings.graphExtractionEnabled })" />
            <span>保存本地 UIE 补充图结果（开放关系优先、智能记忆模式始终保存 API 提取的开放关系）</span>
          </label>
          <div class="field-hint">开放模式使用当前聊天 API 提取实体与原文关系，不依赖 UIE schema；API 不可用时保留本地规则结果，但不能保证发现任意陌生关系。旧的规则模式不会自动向 API 发送原文。</div>
          <h4 class="memory-subheading">原文召回</h4>
          <label class="memory-check-row">
            <input v-model="memorySettings.openSourceRecallEnabled" type="checkbox" :disabled="memoryMutating" @change="saveMemorySettings({ openSourceRecallEnabled: memorySettings.openSourceRecallEnabled })" />
            <span>允许普通历史原文参与聊天：自动沿开放关系寻找关联记忆并发送给当前 API（包含已保存原文；隐私与密钥内容除外）</span>
          </label>
          <details class="uie-preview">
            <summary>试提取实体与信息（仅本地预览，不写入记忆）</summary>
            <textarea v-model="uiePreviewText" maxlength="4000" rows="3" placeholder="输入一段中文文本"></textarea>
            <button class="secondary-btn" :disabled="uiePreviewBusy || !uiePreviewText.trim()" @click="previewUieExtraction">
              {{ uiePreviewBusy ? '提取中…' : '运行 UIE-base' }}
            </button>
            <pre v-if="uiePreviewResult">{{ uiePreviewResult }}</pre>
          </details>
          <label class="memory-check-row">
            <input v-model="memorySettings.imageMemoryEnabled" type="checkbox" :disabled="memoryMutating" @change="saveMemorySettings({ imageMemoryEnabled: memorySettings.imageMemoryEnabled })" />
            <span>仅在我明确说“记住图片/截图”时，本地 OCR 提取图片文字</span>
          </label>
          <h4 class="memory-subheading">本地能力与实验功能</h4>
          <div class="semantic-model-card">
            <div>
              <strong>中文本地语义检索</strong>
              <p>{{ semanticModelName }} · {{ modelProgressLabel() }}</p>
            </div>
            <button v-if="!semanticInstalled" class="secondary-btn" :disabled="semanticInstalling" @click="installSemanticModel">
              {{ semanticInstalling ? '安装中…' : '下载并启用' }}
            </button>
            <button v-else :class="['secondary-btn', { selected: memorySettings.semanticEnabled }]" :disabled="memoryMutating" @click="saveMemorySettings({ semanticEnabled: !memorySettings.semanticEnabled })">
              {{ memorySettings.semanticEnabled ? '语义检索已启用' : '启用语义检索' }}
            </button>
          </div>
          <div class="semantic-model-card">
            <div>
              <strong>V4 Internal 内部评审</strong>
              <p>
                当前 {{ memoryV4EffectiveRolloutStage === 'internal' ? 'Internal' : 'Shadow' }}；
                V3 始终负责正式回答，V4 候选仅显示在回复下方供检查。
              </p>
              <p>{{ v4FeedbackGateLabel() }}</p>
            </div>
            <button
              :class="['secondary-btn', { selected: memorySettings.v4RolloutStage === 'internal' }]"
              :disabled="memoryMutating || !memoryV4RuntimeEnabled || memoryV4RolloutStageLocked"
              @click="saveMemorySettings({ v4RolloutStage: memorySettings.v4RolloutStage === 'internal' ? 'shadow' : 'internal' })"
            >
              {{ memoryV4RolloutStageLocked
                ? '已由环境变量锁定'
                : memorySettings.v4RolloutStage === 'internal' ? '退出 Internal' : '进入 Internal' }}
            </button>
          </div>
          <div class="field-hint">新安装的模型与 OCR 数据保存在可执行文件旁的 ContinuumMemoryData；旧安装会继续使用 DeskPetData，确保已有记忆可见。</div>
        </details>

        <div v-if="!memoryEnabled" class="memory-disabled">
          长期记忆当前不可用。请查看上方错误；若是主动关闭，请检查 <code>config.json</code> 中的 <code>memoryEnabled</code> 或 <code>CONTINUUM_MEMORY_ENABLED</code> 环境变量。
        </div>

        <template v-else>
          <section class="memory-section">
          <h3>手动添加传统记忆</h3>
          <p class="field-hint">管理偏好等记忆条目。这里的列表与上方正式事实（L1）分别保存。</p>
          <label class="field-label" for="manual-memory">添加记忆条目</label>
          <div class="memory-add-row">
            <textarea
              id="manual-memory"
              v-model="manualMemoryInput"
              class="settings-input memory-input"
              maxlength="1000"
              placeholder="例如：我偏好简短的中文回答"
              @keydown.ctrl.enter="addManualMemory"
            />
            <button class="primary-btn" :disabled="memoryMutating || !manualMemoryInput.trim()" @click="addManualMemory">
              {{ memoryMutating ? '处理中...' : '添加' }}
            </button>
          </div>
          <div class="field-hint">Ctrl + Enter 添加，普通 Enter 换行。关闭面板后保留输入草稿。疑似密钥、密码或指令注入内容会被拒绝。</div>
          </section>
          <section class="memory-section">
          <h3>处理进度与待确认事项</h3>
          <p class="field-hint">后台提取进度与人工审核分别显示；任务完成不等于事实已发布。</p>

          <section v-if="captureStatus?.activeSources" class="memory-review-panel">
            <div class="memory-list-header">
              <strong>原文保存与后台提取</strong>
              <span>{{ captureStatus.activeSources }} 条加密原文</span>
            </div>
            <div class="field-hint">原文独立保存。{{ memorySettings.openSourceRecallEnabled && memorySettings.remotePolicy !== 'disabled' ? '获准来源可直接参与原文关联召回，无需先发布规范事实。' : '当前未启用聊天原文召回；请查看上方授权及发送策略。' }}任务完成 {{ captureStatus.tasks.succeeded }} 个，失败 {{ captureStatus.tasks.failed }} 个；完成不代表已发布 L1 事实。</div>
            <div v-if="captureStatus.awaitingProcessor" class="field-hint">{{ captureStatus.awaitingProcessor }} 个任务等待原抽取配置，不会使用当前配置自动重放。</div>
            <div v-if="captureStatus.retryable" class="memory-queue-status">
              <span>{{ captureStatus.retryable }} 个任务可处理或重试（每项最多尝试 3 次）</span>
              <button class="secondary-btn" :disabled="memoryMutating" @click="retryMemoryCaptureTasks">处理 / 重试任务</button>
            </div>
          </section>
          <section v-if="memoryReviewItems.length > 0 || pendingCaptureSegments > 0" class="memory-review-panel">
            <div class="memory-list-header">
              <strong>传统记忆候选 · 待确认</strong>
              <span>隔离的规范候选不直接参与回答；原始来源另按原文召回权限筛选</span>
            </div>
            <div v-if="pendingCaptureSegments > 0" class="memory-queue-status">
              <span>后台仍有 {{ pendingCaptureSegments }} 个长消息分段待处理</span>
              <button class="secondary-btn" :disabled="memoryMutating" @click="flushMemoryCaptureQueue">等待全部完成</button>
            </div>
            <div v-for="review in memoryReviewItems" :key="review.candidate.id" class="memory-review-item">
              <div class="memory-item-main">
                <div class="memory-item-meta">
                  <span class="memory-kind">{{ review.candidate.predicate }}</span>
                  <span class="memory-state conflicted">规范条目待确认</span>
                  <span v-if="review.candidate.calibrationStatus === 'calibrated'">
                    校准概率 {{ Math.round((review.candidate.calibratedActiveProbability || 0) * 100) }}%
                    （保守下界 {{ Math.round((review.candidate.calibrationLowerBound || 0) * 100) }}%）
                  </span>
                  <span v-else>启发式验证分 {{ Math.round((review.candidate.verificationScore || 0) * 100) }}%（尚未校准）</span>
                  <span>证据 {{ Math.round((review.candidate.evidenceScore || 0) * 100) }}%</span>
                </div>
                <div class="memory-content">{{ review.candidate.canonicalText }}</div>
                <details v-if="review.evidence.length > 0" class="memory-review-evidence">
                  <summary>查看原始证据与隔离原因</summary>
                  <div v-for="evidence in review.evidence" :key="evidence.id">{{ evidence.content || '[证据已删除或不可用]' }}</div>
                  <div>原因：{{ (review.candidate.decisionReasonCodes || []).join('、') || (review.candidate.ambiguityFlags || []).join('、') }}</div>
                </details>
              </div>
              <div class="memory-item-actions">
                <button class="memory-restore-btn" :disabled="memoryMutating" @click="reviewMemoryCandidate(review.candidate.id, 'approved')">确认并保存</button>
                <button class="memory-delete-btn" :disabled="memoryMutating" @click="reviewMemoryCandidate(review.candidate.id, 'rejected')">拒绝</button>
              </div>
            </div>
            <div class="memory-review-toolbar">
              <span>策略升级后可影子重跑全部候选，不会直接改动正式记忆。</span>
              <button class="secondary-btn" :disabled="memoryMutating" @click="reprocessMemoryCandidates">影子重处理</button>
            </div>
          </section>

          <details v-if="graphReviewItems.length > 0" class="memory-review-panel">
            <summary>L1 事实候选与实体身份 · {{ graphReviewItems.length }} 条待处理</summary>
            <div class="memory-list-header">
              <strong>正式事实审核</strong>
              <span>仅在需要发布规范事实、绑定实体或主动使用偏好时操作</span>
            </div>
            <div class="field-hint">以下状态仅表示尚未发布正式事实（L1），不是原文不可召回。确认会改变正式事实及身份绑定；拒绝或撤销检索会限制对应原文使用，请谨慎操作。</div>
            <div v-for="item in graphReviewItems" :key="item.review.id" class="memory-review-item">
              <div class="memory-item-main">
                <div class="memory-item-meta">
                  <span class="memory-kind">{{ item.predicate || '未识别关系' }}</span>
                  <span class="memory-state">尚未发布 L1</span>
                  <span>模型分数 {{ Math.round(item.review.modelScore * 100) }}%</span>
                </div>
                <div class="memory-content">候选：{{ item.subject }} — {{ item.predicate }} → {{ item.object }}</div>
                <div class="memory-content">证据：{{ item.evidence || '[来源证据不可用]' }}</div>
                <details v-if="item.sourceText && item.sourceText !== item.evidence" class="field-hint"><summary>查看完整原文及语境</summary>{{ item.sourceText }}</details>
                <div class="field-hint">未发布原因：{{ item.review.reason }} · 来源：{{ item.review.sourceId }} · 发送级别：{{ item.review.sensitivity }}</div>
                <div v-if="item.privacyOrigin === 'uie-default-local'" class="field-hint">此 private 是 UIE 正式事实（L1）的默认本地隔离策略，不代表原文被识别为敏感隐私；原文召回使用独立权限检查。</div>
                <div v-for="mention in item.mentions" :key="mention.id" class="field-hint">
                  实体「{{ mention.text }}」（{{ mention.type }}）
                  <select v-model="graphIdentityChoice(item.review.id)[mention.id]" class="settings-input">
                    <option value="">请选择实体身份</option>
                    <option value="new">建立独立实体（不按同名合并）</option>
                    <option v-for="entity in mention.options" :key="entity.id" :value="entity.id">已有：{{ entity.name }} · {{ entity.id }}</option>
                  </select>
                </div>
                <div class="field-hint">抽取语境：否定 {{ item.context?.negation?.value ?? '未判定' }}；条件 {{ item.context?.condition?.value ?? '未判定' }}；时间 {{ item.context?.time?.value ?? '未判定' }}；说话者 {{ item.context?.speaker?.value ?? '未判定' }}</div>
                <div class="field-hint">仅在需要发布正式事实（L1） 时填写以下语境；原文召回无需填写。“未知”会保留不确定性，不会自动当作肯定事实。</div>
                <select v-model="graphContextChoice(item.review.id).negation" class="settings-input">
                  <option value="">选择肯定或否定</option><option value="positive">肯定</option><option value="negative">否定</option><option value="unknown">未知</option>
                </select>
                <select v-model="graphContextChoice(item.review.id).condition" class="settings-input">
                  <option value="">选择条件</option><option value="none">无条件</option><option value="conditional">有条件 / 假设</option><option value="unknown">未知</option>
                </select>
                <input v-if="graphContextChoice(item.review.id).condition === 'conditional'" v-model="graphContextChoice(item.review.id).conditionText" class="settings-input" maxlength="500" placeholder="填写条件原文" />
                <input v-model="graphContextChoice(item.review.id).time" class="settings-input" placeholder="时间：YYYY-MM-DD、none 或 unknown" />
                <div v-if="graphReviewTimeError(graphContextChoice(item.review.id).time)" class="api-status-message error">{{ graphReviewTimeError(graphContextChoice(item.review.id).time) }}</div>
                <select v-model="graphContextChoice(item.review.id).speaker" class="settings-input">
                  <option value="">选择说话者</option><option value="self">用户本人陈述</option><option value="reported">转述他人</option><option value="unknown">未知</option>
                </select>
                <input v-if="graphContextChoice(item.review.id).speaker === 'reported'" v-model="graphContextChoice(item.review.id).speakerName" class="settings-input" maxlength="200" placeholder="填写被转述者" />
                <input v-model="graphReviewReasons[item.review.id]" class="settings-input" maxlength="500" placeholder="填写审核原因" />
                <label class="memory-check-row">
                  <input v-model="graphRetrievalRetain[item.review.id]" type="checkbox" />
                  <span>保留正式事实（L1） 的检索资格（撤销会同时限制对应来源）</span>
                </label>
                <label class="memory-check-row">
                  <input v-model="graphProactivePreferences[item.review.id]" type="checkbox" />
                  <span>作为我的长期偏好主动使用</span>
                </label>
              </div>
              <div class="memory-item-actions">
                <div v-if="graphReviewErrors[item.review.id]" class="api-status-message error">{{ graphReviewErrors[item.review.id] }}</div>
                <button class="memory-restore-btn" :disabled="memoryMutating || !graphReviewReasons[item.review.id]?.trim() || !graphApprovalReady(item)" @click="reviewGraphCandidate(item.review.id, 'approved')">确认并发布规范事实</button>
                <button class="memory-delete-btn" :disabled="memoryMutating || !graphReviewReasons[item.review.id]?.trim()" @click="reviewGraphCandidate(item.review.id, 'rejected')">拒绝并限制来源使用</button>
                <button class="secondary-btn" :disabled="memoryMutating || !graphReviewReasons[item.review.id]?.trim()" @click="reviewGraphCandidate(item.review.id, 'pending')">保留未发布状态</button>
              </div>
            </div>
          </details>

          <details v-if="graphRelationReviewItems.length > 0" class="memory-review-panel">
            <summary>事实间语义关系 · 待确认（{{ graphRelationReviewItems.length }} 条）</summary>
            <div class="memory-list-header"><strong>规范信息关系</strong><span>仅用于正式关系确认，不是原文关联召回的前置步骤</span></div>
            <div v-for="item in graphRelationReviewItems" :key="item.key" class="memory-review-item">
              <div class="memory-item-main">
                <div class="memory-item-meta">
                  <span class="memory-kind">{{ item.result.label }}</span>
                  <span class="memory-state">未确认规范关系</span>
                  <span>模型分数 {{ Math.round((item.result.scores?.[item.result.label] || 0) * 100) }}%</span>
                </div>
                <div class="memory-content">{{ item.evidence[0] || '[第一条证据不可用]' }}</div>
                <div class="memory-content">{{ item.evidence[1] || '[第二条证据不可用]' }}</div>
                <div class="field-hint">来源版本：{{ item.claims.map(claim => `${claim.id}@${claim.version}`).join(' ↔ ') }} · 隐私：{{ item.sensitivity }} · {{ item.result.truncated ? '模型输入已截断' : '模型输入完整' }}</div>
                <input v-model="graphRelationReviewReasons[item.key]" class="settings-input" maxlength="500" placeholder="填写审核原因" />
              </div>
              <div class="memory-item-actions">
                <button class="memory-restore-btn" :disabled="memoryMutating || !graphRelationReviewReasons[item.key]?.trim()" @click="reviewGraphRelation(item.key, 'accepted')">记录确认</button>
                <button class="memory-delete-btn" :disabled="memoryMutating || !graphRelationReviewReasons[item.key]?.trim()" @click="reviewGraphRelation(item.key, 'rejected')">拒绝</button>
                <button class="secondary-btn" :disabled="memoryMutating || !graphRelationReviewReasons[item.key]?.trim()" @click="reviewGraphRelation(item.key, 'pending')">继续待确认</button>
              </div>
            </div>
          </details>

          <details v-if="graphL2Candidates.length > 0" class="memory-review-panel">
            <summary>L2 关系候选 · 待发布（{{ graphL2Candidates.length }} 条）</summary>
            <div class="memory-list-header"><strong>L2 关系候选</strong><span>必须核实两条原文之间的语义；图中连接和 NLI 分数都不足以自动发布关系</span></div>
            <div v-for="item in graphL2Candidates" :key="item.id" class="memory-review-item">
              <div class="memory-item-main">
                <div class="memory-item-meta">
                  <span class="memory-kind">{{ item.kind }}</span>
                  <span>候选 · {{ item.sensitivity }}</span>
                  <span>{{ item.from.id }}@{{ item.from.version }} → {{ item.to.id }}@{{ item.to.version }}</span>
                </div>
                <div class="memory-content">{{ item.fromEvidence || '[第一条证据不可用]' }}</div>
                <div class="memory-content">{{ item.toEvidence || '[第二条证据不可用]' }}</div>
                <div class="field-hint">{{ item.observations.map(obs => `${obs.predicted} ${Math.round((obs.scores?.[obs.predicted] || 0) * 100)}%${obs.truncated ? '（截断）' : ''}`).join(' · ') }}</div>
                <input v-model="graphL2PublishReasons[item.id]" class="settings-input" maxlength="500" placeholder="说明你如何核实这条关系的方向与语义" />
              </div>
              <div class="memory-item-actions">
                <button class="memory-restore-btn" :disabled="memoryMutating || !graphL2PublishReasons[item.id]?.trim() || !item.observations.some(obs => !obs.truncated)" @click="publishGraphL2Relation(item.id)">核实并发布 L2</button>
              </div>
            </div>
          </details>

          </section>
          <section class="memory-section">
          <div class="memory-list-header">
            <strong>已保存的传统记忆</strong>
            <span>按最近更新时间排序</span>
          </div>

          <div v-if="memoryLoading" class="memory-empty">正在读取长期记忆...</div>
          <div v-else-if="memoryItems.length === 0" class="memory-empty">还没有传统记忆条目。正式事实和原文来源请查看上方；你也可以手动添加偏好。</div>
          <div v-else class="memory-list">
            <div v-for="item in memoryItems" :key="item.id" class="memory-item">
              <div class="memory-item-main">
                <div class="memory-item-meta">
                  <span class="memory-kind">{{ memoryKindLabel(item) }}</span>
                  <span :class="['memory-state', item.status || 'active']">{{ memoryStatusLabel(item) }}</span>
                  <span>{{ formatMemoryDate(item) }}</span>
                  <span v-if="item.accessCount">召回 {{ item.accessCount }} 次</span>
                </div>
                <div v-if="editingMemoryId !== item.id" class="memory-content">{{ item.content }}</div>
                <div v-else class="memory-edit-row">
                  <textarea v-model="editingMemoryContent" class="settings-input memory-input" maxlength="1000" />
                  <div>
                    <button class="memory-restore-btn" :disabled="memoryMutating || !editingMemoryContent.trim()" @click="saveEditedMemory(item)">保存新版本</button>
                    <button class="memory-delete-btn" :disabled="memoryMutating" @click="cancelEditMemory">取消</button>
                  </div>
                </div>
                <div class="memory-item-controls">
                  <label>重要度
                    <select v-model.number="item.importance" :disabled="memoryMutating" @change="updateMemory(item, { importance: item.importance })">
                      <option :value="0.25">低</option>
                      <option :value="0.6">中</option>
                      <option :value="0.85">高</option>
                      <option :value="1">最高</option>
                    </select>
                  </label>
                  <label>敏感级别
                    <select v-model="item.sensitivity" :disabled="memoryMutating" @change="updateMemorySensitivity(item)">
                      <option value="normal">普通</option>
                      <option value="private">隐私</option>
                      <option value="secret">机密（绝不发送）</option>
                    </select>
                  </label>
                  <label>分享策略
                    <select v-model="item.sharePolicy" :disabled="memoryMutating || item.sensitivity === 'secret'" @change="updateMemory(item, { sharePolicy: item.sharePolicy })">
                      <option value="allow-remote">允许随请求发送</option>
                      <option value="local-only">仅限本机</option>
                      <option value="ask">待授权（暂不发送）</option>
                    </select>
                  </label>
                </div>
              </div>
              <div class="memory-item-actions">
                <button v-if="editingMemoryId !== item.id && item.status !== 'deleted'" class="memory-restore-btn" :disabled="memoryMutating" @click="beginEditMemory(item)">编辑正文</button>
                <button v-if="(!item.status || item.status === 'active')" class="memory-restore-btn" :disabled="memoryMutating" @click="suppressMemory(item)">停止使用</button>
                <button v-if="item.status && item.status !== 'active'" class="memory-restore-btn" :disabled="memoryMutating" @click="restoreMemory(item)">恢复</button>
                <button
                  :class="['memory-delete-btn', { confirm: pendingDeleteMemoryId === item.id }]"
                  :disabled="memoryMutating"
                  @click="deleteMemory(item.id)"
                >
                  {{ pendingDeleteMemoryId === item.id ? '确认普通删除' : '普通删除' }}
                </button>
                <button class="memory-purge-btn" :disabled="memoryMutating" @click="preparePurgeMemory(item.id)">彻底清除…</button>
              </div>
              <div v-if="pendingPurgeMemoryId === item.id" class="memory-purge-confirm">
                <strong>不可恢复操作</strong>
                <span>{{ purgeWarning }}</span>
                <label>输入“彻底清除”确认
                  <input v-model="purgePhrase" class="settings-input" type="text" autocomplete="off" @keydown.enter="!$event.isComposing && $event.keyCode !== 229 && confirmPurgeMemory(item.id)" />
                </label>
                <div>
                  <button class="danger-btn" :disabled="memoryMutating || purgePhrase.trim() !== '彻底清除'" @click="confirmPurgeMemory(item.id)">清除正文、版本、证据和受管备份</button>
                  <button class="memory-restore-btn" :disabled="memoryMutating" @click="cancelPurgeMemory">取消</button>
                </div>
              </div>
            </div>
          </div>

          <div class="memory-footer">
            <span>记忆加密写入 <code>memories.enc</code>；普通删除保留 V4 审计墓碑，“彻底清除”才会移除可恢复正文、版本、独占证据和受管备份。</span>
            <button class="danger-btn" :disabled="memoryMutating || memoryItems.length === 0" @click="clearAllMemories">
              {{ confirmClearMemories ? '再次确认清空传统记忆' : '清空传统记忆（保留审计）' }}
            </button>
          </div>
          </section>
        </template>
        <details class="memory-section memory-advanced">
          <summary>高级管理与运行诊断</summary>
          <p class="field-hint">查看存储位置、提取状态、关系归并和 L2 状态，或手动处理历史记录。</p>
        <div v-if="memoryStoragePath" class="memory-path" :title="memoryStoragePath">{{ memoryStoragePath }}</div>
        <div v-if="graphL1View" class="field-hint" :title="graphL1View.manifestId">图视图已就绪：{{ graphL1View.information }} 条原文信息节点（未断言）、{{ graphL1View.openAssertions ?? 0 }} 条可本地关联查询的开放记录（含自动准入，不等于事实确认）、{{ graphL1View.claims }} 条正式事实（L1）、{{ graphL1View.argumentEdges }} 条图连接</div>
        <div v-if="graphExtractionStatus" class="field-hint">图提取：{{ graphExtractionStatus.enabled ? (graphExtractionStatus.modelReady ? '已开启' : '模型不可用，可使用本地回退') : '未开启' }} · {{ graphExtractionStatus.runs }} 次提取、{{ graphExtractionStatus.factCandidates }} 条关系/事件记录、{{ graphExtractionStatus.claims }} 条正式事实（其中 {{ graphExtractionStatus.basicClaims ?? 0 }} 条使用基础注册关系）；未发布的记录仍可按权限参与原文召回。</div>
        <details v-if="graphExtractionStatus?.pendingReviews" class="field-hint">
          <summary>可选：规范事实自动评估（{{ graphExtractionStatus.pendingReviews }} 条尚未发布）</summary>
          此处仅处理旧记录的自动发布重试，不是原文召回的审核待办。启动时会分批处理旧的机器待审项，用户拒绝与明确暂缓不会被覆盖。
          <button class="secondary-btn" :disabled="memoryMutating || !graphExtractionStatus.enabled" @click="reassessPendingGraphFacts">按新策略自动重审图事实（每次最多 20 条）</button>
        </details>
        <div v-if="graphExtractionStatus" class="field-hint">开放关系：{{ graphExtractionStatus.automaticOpenNavigation ?? 0 }} 条自动准入本地查询，{{ graphExtractionStatus.deferredOpenCandidates ?? 0 }} 条按需核实候选；已基础注册 {{ graphExtractionStatus.basicRelations ?? 0 }} 种关系。证据完整、角色明确的新关系可自动发布为 L1；含义不明的结果继续保留为候选。</div>
        <div class="field-hint">
          <button class="secondary-btn" :disabled="clarificationBusy || !apiConfigured" @click="migrateOpenL1">使用当前 API 处理历史开放记录（每批 5 条）</button>
          <span>{{ semanticMigrationMessage }}</span>
        </div>
        <details v-if="graphRelationMappings.some(m => m.active)">
          <summary>已启用的关系归并</summary>
          <div v-for="mapping in graphRelationMappings.filter(m => m.active)" :key="mapping.id" class="field-hint">
            {{ mapping.sourceText }} → {{ mapping.targetText }}
            <button class="secondary-btn" :disabled="clarificationBusy" @click="revokeRelationMapping(mapping.id)">撤销归并并重新整理</button>
          </div>
        </details>
        <div v-if="graphExtractionStatus?.sourcesWithoutFacts" class="field-hint">
          {{ graphExtractionStatus.sourcesWithoutFacts }} 条来源尚未提取出关系；获准原文仍可直接检索，补充提取仅用于改善关联导航。
          <button class="secondary-btn" :disabled="memoryMutating || !graphExtractionStatus.enabled || !graphExtractionStatus.modelReady" @click="reextractEmptyGraphSources">重新提取无事实记录（每次最多 5 条）</button>
        </div>
        <div v-if="graphL2View" class="field-hint" :title="graphL2View.manifestId">L2 关系快照已就绪：{{ graphL2View.candidates }} 条候选、{{ graphL2View.relations }} 条已发布关系（图模式下可参与聊天召回）</div>

        <div class="api-status-message">
          <button class="secondary-btn" :disabled="graphDiagnosticLoading" @click="inspectGraphInputs">{{ graphDiagnosticLoading ? '检查中…' : '检查图记忆接入' }}</button>
          <p v-if="graphDiagnosticMessage">{{ graphDiagnosticMessage }}</p>
        </div>

        </details>

      </div>
    </div>

    <div class="chat-shell">
    <div class="chat" ref="chatEl" tabindex="0" aria-label="聊天记录" @keydown.capture="onChatNavigation" @wheel.passive="markChatScroll" @pointerdown="markChatScroll" @touchstart.passive="markChatScroll" @scroll.passive="onChatScroll">
      <div v-if="messages.length === 0" class="empty">
        <div class="empty-mark"><MemoryMark /></div>
        <span class="empty-eyebrow">CONTINUUM MEMORY</span>
        <h1>从一段对话开始</h1>
        <p>聊聊你的想法，让重要的信息留在记忆里。</p>
        <div class="empty-features"><span><AppIcon name="memory" />独立记忆</span><span><AppIcon name="skill" />Skill 协作</span><span><AppIcon name="document" />PDF 与 Word</span></div>
      </div>
      <div v-for="msg in messages" :key="msg.id" :data-message-id="msg.id" :class="['message', msg.role, { 'search-highlight': highlightedMessageId === msg.id }]">
        <span v-if="msg.role === 'assistant'" class="assistant-avatar"><MemoryMark /></span>
        <div class="message-body">
          <span class="message-author">{{ msg.role === 'user' ? '你' : agentName }}</span>
          <div class="bubble">
            <span v-if="msg.hasImage" class="img-tag">📷 识屏</span>
            <blockquote v-if="msg.quote" class="message-reference"><small>{{ msg.quote.role === 'user' ? '引用你的消息' : '引用回答' }}</small>{{ msg.quote.content }}</blockquote>
            <MessageMarkdown :content="msg.content || (msg.status === 'failed' ? '请求失败，请点击重试。' : msg.status === 'stopped' ? '回复已停止。' : msg.role === 'assistant' && isLoading ? '…' : '')" :streaming="msg.role === 'assistant' && isLoading" @notice="notifyChat" />
          </div>
          <div v-if="msg.content || msg.status" class="message-tools"><button title="复制消息或选中内容" aria-label="复制消息" :disabled="!msg.content" @mousedown.prevent @click="copyMessage(msg)"><AppIcon name="copy" />复制</button><button title="引用消息或选中内容" aria-label="引用消息" :disabled="!msg.content || isLoading || conversationSwitching" @mousedown.prevent @click="quoteMessage(msg)"><AppIcon name="quote" />引用</button><button :class="{ saved: savedKeys.has(bookmarkKey(activeConversationId, msg.id)) }" :disabled="!msg.content || bookmarkBusy || isLoading" :aria-label="savedKeys.has(bookmarkKey(activeConversationId, msg.id)) ? '取消收藏消息' : '收藏消息'" :aria-pressed="savedKeys.has(bookmarkKey(activeConversationId, msg.id))" @click="toggleBookmark(activeConversationId, msg.id, !savedKeys.has(bookmarkKey(activeConversationId, msg.id)))"><AppIcon name="bookmark" />{{ savedKeys.has(bookmarkKey(activeConversationId, msg.id)) ? '已收藏' : '收藏' }}</button><span v-if="msg.status" class="message-state" :class="{ failed: msg.status === 'failed' }">{{ msg.status === 'stopped' ? '已停止生成' : '请求失败' }}</span><button v-if="msg.role === 'assistant' && msg.status && msg.replyTo && msg.id === messages[messages.length - 1]?.id" :disabled="isLoading || conversationSwitching" aria-label="重试回复" @click="send(msg.replyTo)"><AppIcon name="reset" />重试</button></div>
          <details v-if="msg.memoryReview" class="v4-internal-review">
            <summary>
              V4 内部候选 · 不参与正式回答 ·
              {{ msg.memoryReview.v4.abstained ? '已拒答' : `${msg.memoryReview.v4.candidates.length} 条证据` }}
            </summary>
            <div class="v4-review-warning">
              当前回复仍完全由 V3 记忆生成；这里仅用于本地比较，不会再次发送给模型。
            </div>
            <div class="v4-review-metrics">
              <span>V3 注入 {{ msg.memoryReview.v3.injectedCount }}</span>
              <span>V4 最佳证据 {{ Math.round(msg.memoryReview.v4.bestEvidenceScore * 100) }}%</span>
              <span>拒答门槛 {{ Math.round(msg.memoryReview.v4.threshold * 100) }}%</span>
              <span>重合 {{ msg.memoryReview.agreement.overlapCount }}</span>
            </div>
            <div class="v4-review-query-feedback">
              <span>请评价这一轮是否需要长期记忆：</span>
              <button
                :class="{ selected: v4InternalFeedback[v4FeedbackKey(msg.memoryReview.reviewId)] === 'missing' }"
                :disabled="!!v4InternalFeedbackPending"
                @click="submitV4InternalFeedback(msg.memoryReview.reviewId, undefined, 'missing')"
              >标记遗漏</button>
              <button
                :class="{ selected: v4InternalFeedback[v4FeedbackKey(msg.memoryReview.reviewId)] === 'no-memory' }"
                :disabled="!!v4InternalFeedbackPending"
                @click="submitV4InternalFeedback(msg.memoryReview.reviewId, undefined, 'no-memory')"
              >确认无需记忆</button>
              <small v-if="v4InternalFeedbackError[v4FeedbackKey(msg.memoryReview.reviewId)]">
                {{ v4InternalFeedbackError[v4FeedbackKey(msg.memoryReview.reviewId)] }}
              </small>
            </div>
            <div v-for="candidate in msg.memoryReview.v4.candidates" :key="candidate.factId" class="v4-review-candidate">
              <div>{{ candidate.content }}</div>
              <small>
                证据 {{ Math.round(candidate.score * 100) }}% · {{ candidate.status }} ·
                {{ candidate.routes.join(' + ') }}
              </small>
              <div class="v4-review-feedback-actions">
                <button
                  v-for="option in V4_INTERNAL_CANDIDATE_FEEDBACK_OPTIONS"
                  :key="option.label"
                  :class="{ selected: v4InternalFeedback[v4FeedbackKey(msg.memoryReview.reviewId, candidate.factId)] === option.label }"
                  :disabled="!!v4InternalFeedbackPending"
                  @click="submitV4InternalFeedback(msg.memoryReview.reviewId, candidate.factId, option.label)"
                >{{ option.text }}</button>
              </div>
              <small v-if="v4InternalFeedbackError[v4FeedbackKey(msg.memoryReview.reviewId, candidate.factId)]" class="v4-review-feedback-error">
                {{ v4InternalFeedbackError[v4FeedbackKey(msg.memoryReview.reviewId, candidate.factId)] }}
              </small>
            </div>
            <div v-if="msg.memoryReview.v4.candidates.length === 0" class="v4-review-empty">
              V4 判断当前没有足够可靠的长期记忆。
            </div>
          </details>
        </div>
        <button v-if="!isLoading" class="rollback-btn" title="从这条消息撤回" @click="rollback(msg.id)">↩</button>
      </div>
    </div>

    <!-- Pending image preview -->
    <button v-if="!followLatest" class="latest-message-button" aria-label="回到最新消息" @click="scrollToBottom()"><AppIcon name="arrow-right" />{{ unreadReply ? '有新内容 · 回到最新' : '回到最新消息' }}</button>
    </div>
    <div v-if="pendingImage" class="image-preview">
      <img :src="`data:${pendingImage.mimeType};base64,${pendingImage.data}`" alt="screenshot" />
      <button class="clear-img" @click="clearPendingImage">✕</button>
    </div>

    <!-- Voice error toast -->
    <div v-if="voiceError" class="voice-error">{{ voiceError }}</div>

    <div v-if="!isLoading && (clarificationItems.length || semanticFailures)" class="memory-clarifications">
      <div v-if="clarificationError" class="field-hint">{{ clarificationError }}</div>
      <div v-for="item in clarificationItems" :key="item.id + item.candidateId" class="memory-card">
        <strong>补充记忆信息</strong>
        <blockquote>{{ item.sourceText }}</blockquote>
        <p>{{ item.question }}</p>
        <button v-for="choice in item.options" :key="choice" class="secondary-btn"
          @click="clarificationReplies[item.id + item.candidateId] = choice">{{ choice }}</button>
        <textarea class="settings-input clarification-input" rows="3" v-model="clarificationReplies[item.id + item.candidateId]" placeholder="补充说明，也可以在下面选择已有消息" :disabled="clarificationBusy" />
        <select class="settings-input" v-model="clarificationContextIds[item.id + item.candidateId]" :disabled="clarificationBusy">
          <option value="">不引用其他消息</option>
          <option v-for="context in clarificationContexts" :key="context.id" :value="context.id">{{ context.text }}</option>
        </select>
        <button class="secondary-btn" :disabled="clarificationBusy" @click="answerClarification(item)">提交补充</button>
        <button class="secondary-btn" :disabled="clarificationBusy" @click="dismissClarification(item)">不保存这条候选</button>
        <span class="field-hint">可以稍后再答，正常聊天无需等待。</span>
      </div>
      <button v-if="semanticFailures" class="secondary-btn" :disabled="clarificationBusy" @click="retrySemanticFailures">重试未完成的记忆整理（{{ semanticFailures }}）</button>
    </div>
    <div class="composer input-area">
      <div class="composer-controls">
        <button class="tool-btn" :disabled="documentsBusy || conversationSwitching" title="选择 PDF 或 Word 文档" aria-label="选择 PDF 或 Word 文档" @click="pickDocuments"><AppIcon name="attachment" /></button>
        <button v-if="!compactComposer" class="tool-btn" :class="{ capturing: isCapturing }" :disabled="isCapturing || isLoading" title="识屏" aria-label="识屏" @click="captureScreen"><AppIcon name="capture" /></button>
        <button v-if="!compactComposer" class="tool-btn" :class="{ listening: isListening }" :disabled="isLoading" title="语音输入" aria-label="语音输入" :aria-pressed="isListening" @click="toggleListening"><AppIcon name="mic" /></button>
        <button class="tool-btn" :disabled="isLoading || conversationSwitching" title="展开输入框" aria-label="展开输入框" @click="expandComposer"><AppIcon name="expand" /></button>
        <div v-if="compactComposer" class="input-more-wrap"><button class="tool-btn" title="更多输入方式" aria-label="更多输入方式" :aria-expanded="showInputMenu" @click="showInputMenu = !showInputMenu"><AppIcon name="more" /></button><div v-if="showInputMenu" class="input-more-menu"><button :disabled="isLoading || isCapturing" @click="captureScreen(); showInputMenu = false"><AppIcon name="capture" />识屏</button><button :disabled="isLoading" @click="toggleListening(); showInputMenu = false"><AppIcon name="mic" />语音输入</button></div></div>
        <button class="tool-btn" :disabled="isLoading || conversationSwitching" title="快捷短语" aria-label="快捷短语" @click="showQuickPhrases = true"><AppIcon name="phrase" /></button>
      </div>
      <div class="composer-input"><blockquote v-if="quotedMessage" class="composer-reference"><span><strong>{{ quotedMessage.role === 'user' ? '引用你的消息' : '引用回答' }}</strong><small>{{ quotedMessage.content }}</small></span><button aria-label="取消引用" title="取消引用" @click="quotedMessage = undefined"><AppIcon name="close" /></button></blockquote><textarea ref="composerTextarea" v-model="input" maxlength="200000" placeholder="输入消息…" aria-label="聊天消息" :disabled="isLoading || conversationSwitching" @keydown="onKeydown" rows="1" /></div>
      <SkillPicker class="skill-selection" v-model="selectedSkillId" :items="enabledSkills" :compact="compactComposer" :disabled="isLoading || conversationSwitching" />
      <button v-if="isLoading" class="stop-generation-btn" :disabled="stoppingGeneration" :title="stoppingGeneration ? '正在停止…' : '停止生成'" aria-label="停止生成" @click="stopGeneration"><AppIcon name="stop" /></button>
      <button v-else class="send-btn" title="发送消息" aria-label="发送消息" :disabled="isLoading || (!input.trim() && !pendingImage)" @click="send()"><SendArtwork :theme="currentTheme.id" /></button>
    </div>
    <div class="input-help">{{ sendHint }}<span v-if="draftStatus" class="draft-indicator" :class="{ failed: draftError }" role="status">{{ draftStatus }}</span></div>
  </div>
</template>

<style>
.memory-clarifications { flex-shrink: 0; max-height: 260px; overflow-y: auto; padding: 12px 16px; border-top: 1px solid var(--border); }
.memory-clarifications .memory-card { padding: 12px; margin-bottom: 10px; border-radius: 10px; background: var(--surface); border: 1px solid var(--border); }
.memory-clarifications blockquote { margin: 8px 0; padding-left: 10px; border-left: 2px solid var(--accent); overflow-wrap: anywhere; }
.memory-clarifications .settings-input { display: block; width: 100%; box-sizing: border-box; margin: 8px 0; }
.clarification-input { resize: vertical; min-height: 72px; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }

/* Loading */
.loading { display: flex; align-items: center; justify-content: center; height: 100vh; background: #0f1117; }
.spinner { width: 28px; height: 28px; border: 3px solid #353840; border-top-color: #2d7d46; border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* Setup */
.setup { display: flex; align-items: center; justify-content: center; height: 100vh; background: var(--bg); color: var(--text); }
.setup-card { text-align: center; display: flex; flex-direction: column; gap: 16px; width: 320px; }
.setup-card h1 { font-size: 24px; font-weight: 600; }
.setup-version { align-self: center; margin-top: -10px; color: var(--text-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.setup-card p { opacity: 0.6; font-size: 14px; }
.setup-card input { background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; font-size: 16px; outline: none; text-align: center; font-family: inherit; }
.setup-card input:focus { border-color: var(--accent); }
.setup-card button { background: var(--accent); color: #fff; border: none; border-radius: 10px; padding: 12px; font-size: 15px; cursor: pointer; font-family: inherit; }
.setup-card button:disabled { opacity: 0.4; cursor: default; }

/* Chat */
.app { display: flex; flex-direction: column; height: 100vh; background: var(--bg); color: var(--text); }

.header { display: flex; align-items: center; gap: 10px; padding: 10px 20px; background: var(--bg); border-bottom: 1px solid var(--border); position: relative; }
.header .name { font-size: 15px; font-weight: 600; }
.header .version-badge { color: var(--text-muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.header .badge { font-size: 11px; color: var(--accent); background: var(--accent-soft); padding: 2px 8px; border-radius: 6px; }
.header .spacer { flex: 1; }
.conversation-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 20px; border-bottom: 1px solid var(--border); background: var(--surface); }
.conversation-bar label { color: var(--text); font-size: 12px; }
.conversation-bar select, .conversation-bar input { min-width: 150px; max-width: 260px; padding: 7px 9px; border: 1px solid var(--border); border-radius: 7px; color: var(--text); background: var(--bg); font: inherit; font-size: 12px; }
.conversation-bar > span { color: var(--text-muted); font-size: 11px; }
.conversation-error { padding: 8px 20px; color: #e76f61; font-size: 12px; }
.icon-btn { background: transparent; color: var(--text-muted); border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; font-size: 14px; cursor: pointer; font-family: inherit; }
.icon-btn:hover { background: var(--surface); color: var(--text); }
.icon-btn.active { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
.reset-btn { white-space: nowrap; font-size: 12px; }
.api-btn { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; }
.api-dot { width: 7px; height: 7px; border-radius: 50%; background: #d97757; box-shadow: 0 0 0 2px rgba(217,119,87,0.15); }
.api-btn.active .api-dot { background: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.memory-btn { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; font-size: 12px; }
.memory-count { min-width: 18px; padding: 1px 5px; border-radius: 9px; background: var(--accent-soft); color: var(--accent); text-align: center; font-size: 10px; }

/* API settings dialog */
.modal-backdrop { position: fixed; inset: 0; z-index: 300; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0,0,0,0.58); backdrop-filter: blur(3px); }
.api-dialog, .memory-dialog, .skill-dialog { max-height: calc(100vh - 48px); overflow-y: auto; padding: 22px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); color: var(--text); box-shadow: 0 24px 70px rgba(0,0,0,0.45); }
.api-dialog { width: min(480px, 100%); }
.memory-dialog { width: min(780px, 100%); }
.skill-dialog { width: min(760px, 100%); }
.skill-dialog > .dialog-header { position: sticky; top: -22px; z-index: 2; margin: -22px -22px 12px; padding: 18px 22px 14px; background: var(--surface); border-bottom: 1px solid var(--border); }
.skill-toolbar, .skill-selection { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.skill-toolbar { margin: 12px 0; }
.skill-toolbar input { flex: 1; min-width: 160px; }
.skill-card { margin-top: 12px; padding: 13px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg); }
.skill-card-title { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: 13px; }
.skill-card-title > span { color: var(--text-muted); font-size: 11px; }
.skill-card-title label { margin-left: auto; font-size: 12px; }
.skill-card > p { margin: 8px 0; color: var(--text); font-size: 12px; line-height: 1.6; }
.skill-card > button { margin-top: 10px; margin-right: 8px; }
.skill-path { margin-top: 6px; font-size: 10px; color: var(--text-muted); overflow-wrap: anywhere; }
.skill-preview { max-height: 280px; overflow: auto; margin-top: 10px; padding: 10px; border-radius: 6px; background: var(--surface); color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
.skill-selection { padding: 8px 20px 0; background: var(--bg); color: var(--text-muted); font-size: 11px; }
.skill-selection select { max-width: 260px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); font: inherit; }
.document-preview { margin-top: 16px; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); }
.document-preview img { display: block; max-width: 100%; margin: 10px auto; border: 1px solid var(--border); }
.document-preview p { white-space: pre-wrap; font-size: 12px; line-height: 1.7; }
.document-preview h3, .document-preview h4 { margin: 12px 0 8px; }
.document-preview table { width: 100%; border-collapse: collapse; font-size: 12px; margin: 10px 0; }
.document-preview td { padding: 8px; border: 1px solid var(--border); white-space: pre-wrap; overflow-wrap: anywhere; }
.header { flex-wrap: wrap; }
.dialog-header { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 20px; }
.dialog-header h2 { font-size: 19px; font-weight: 650; }
.dialog-header p { margin-top: 5px; color: var(--text-muted); font-size: 12px; }
.dialog-close { margin-left: auto; border: 0; background: transparent; color: var(--text-muted); padding: 4px; font-size: 16px; cursor: pointer; }
.dialog-close:hover { color: var(--text); }
.field-label { display: block; margin: 14px 0 7px; color: var(--text); font-size: 13px; font-weight: 600; }
.settings-input { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; outline: none; background: var(--bg); color: var(--text); font-family: inherit; font-size: 13px; }
.settings-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.field-hint { margin-top: 6px; color: var(--text-muted); font-size: 11px; line-height: 1.4; }
.api-status-message { margin-top: 14px; padding: 9px 11px; border-radius: 7px; background: var(--accent-soft); color: var(--accent); font-size: 12px; }
.api-status-message.error { background: rgba(231,76,60,0.14); color: #e76f61; }
.dialog-actions { display: flex; align-items: center; gap: 8px; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); }
.configured-state { color: var(--text-muted); font-size: 11px; }
.configured-state.ready { color: var(--accent); }
.dialog-spacer { flex: 1; }
.secondary-btn, .primary-btn { border-radius: 7px; padding: 8px 13px; font-family: inherit; font-size: 12px; cursor: pointer; }
.secondary-btn { border: 1px solid var(--border); background: transparent; color: var(--text); }
.primary-btn { border: 1px solid var(--accent); background: var(--accent); color: #fff; }
.secondary-btn:disabled, .primary-btn:disabled, .dialog-close:disabled { opacity: 0.5; cursor: default; }

/* Long-term memory manager */
.memory-overview { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 16px; }
.memory-overview > div { display: grid; gap: 6px; padding: 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); }
.memory-overview span { color: var(--text); font-size: 12px; }
.memory-overview strong { color: var(--accent); font-size: 25px; font-weight: 650; }
.memory-overview small { color: var(--text-muted); font-size: 11px; line-height: 1.5; }
.memory-section { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border); }
.memory-section h3 { margin: 0; font-size: 14px; font-weight: 650; }
.memory-section > .field-hint { margin-bottom: 10px; }
.memory-dialog summary { cursor: pointer; line-height: 1.6; }
.memory-advanced > summary { color: var(--text-muted); font-size: 12px; font-weight: 600; }
.memory-subheading { margin: 18px 0 8px; font-size: 12px; }
.memory-fact-fields { display: grid; gap: 7px; margin: 10px 0; font-size: 12px; }
.memory-fact-fields > div { display: grid; grid-template-columns: minmax(70px, 0.3fr) 1fr; gap: 12px; }
.memory-fact-fields dt { color: var(--text-muted); overflow-wrap: anywhere; }
.memory-fact-fields dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.formal-claims { margin-top: 12px; }
.formal-claims > article { margin-top: 8px; }
.formal-claims blockquote { margin: 8px 0; padding: 8px 12px; border-left: 3px solid var(--accent); background: var(--surface); white-space: pre-wrap; overflow-wrap: anywhere; }
.memory-dialog .memory-item-meta { flex-wrap: wrap; }
.memory-dialog .memory-list-header { gap: 12px; flex-wrap: wrap; }
.memory-dialog .semantic-model-card p { white-space: normal; line-height: 1.5; }
.memory-dialog > .dialog-header { position: sticky; top: -22px; z-index: 2; margin: -22px -22px 16px; padding: 18px 22px 14px; background: var(--surface); border-bottom: 1px solid var(--border); }
.memory-dialog .field-hint { font-size: 12px; line-height: 1.65; }
.memory-dialog .field-hint p { margin-top: 8px; }
.memory-dialog .memory-check-row { align-items: flex-start; font-size: 12px; line-height: 1.6; }
.memory-dialog .memory-check-row input { flex-shrink: 0; margin-top: 3px; }
.memory-dialog .memory-item-meta, .memory-dialog .memory-list-header span { font-size: 11px; line-height: 1.5; }
.memory-dialog .memory-settings-grid label { font-size: 12px; }
.memory-dialog .memory-item-actions, .memory-dialog .memory-footer { flex-wrap: wrap; }
.memory-dialog summary:focus-visible, .memory-dialog button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.memory-context-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
.memory-context-tags span { padding: 3px 8px; border: 1px solid var(--border); border-radius: 5px; color: var(--text-muted); font-size: 11px; }
.memory-more-btn { margin-top: 10px; }
.memory-source-list > summary { font-size: 14px; font-weight: 600; }
.memory-source-list > article { margin-top: 8px; }
.memory-dialog .memory-settings-title { justify-content: flex-start; flex-wrap: wrap; font-size: 13px; list-style: none; }
.memory-settings-title::-webkit-details-marker { display: none; }
.memory-settings-title::before { content: '▸'; color: var(--text-muted); }
.memory-settings-panel[open] > .memory-settings-title::before { content: '▾'; }
.memory-settings-title .memory-encryption-state { margin-left: auto; }
@media (max-width: 480px) { .memory-overview { grid-template-columns: 1fr; } .memory-summary { flex-wrap: wrap; } }

.memory-summary { display: flex; align-items: center; gap: 8px; }
.memory-path { margin-top: 10px; padding: 8px 10px; overflow: hidden; border: 1px solid var(--border); border-radius: 7px; background: var(--bg); color: var(--text-muted); font-family: Consolas, monospace; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.memory-settings-panel { margin-top: 14px; padding: 13px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); }
.uie-preview { margin-top: 12px; color: var(--text-muted); font-size: 11px; }
.uie-preview textarea { display: block; box-sizing: border-box; width: 100%; margin: 8px 0; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); resize: vertical; }
.uie-preview pre { max-height: 240px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
.memory-settings-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; }
.memory-encryption-state { color: #e76f61; font-size: 10px; }
.memory-encryption-state.ready { color: var(--accent); }
.memory-settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 11px; }
.memory-settings-grid label, .memory-item-controls label { color: var(--text-muted); font-size: 10px; }
.memory-settings-grid label > span { display: block; margin-bottom: 5px; }
.memory-settings-grid select, .memory-item-controls select { width: 100%; padding: 7px 8px; border: 1px solid var(--border); border-radius: 6px; outline: none; background: var(--surface); color: var(--text); font: inherit; }
.memory-check-row { display: flex; align-items: center; gap: 7px; margin-top: 11px; color: var(--text); font-size: 11px; cursor: pointer; }
.memory-check-row input { accent-color: var(--accent); }
.semantic-model-card { display: flex; align-items: center; gap: 12px; margin-top: 11px; padding: 9px 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); }
.semantic-model-card > div { min-width: 0; flex: 1; }
.semantic-model-card strong { font-size: 11px; }
.semantic-model-card p { margin-top: 3px; overflow: hidden; color: var(--text-muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.secondary-btn.selected { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.memory-disabled, .memory-empty { margin-top: 16px; padding: 22px 16px; border: 1px dashed var(--border); border-radius: 9px; color: var(--text-muted); text-align: center; font-size: 12px; line-height: 1.6; }
.memory-disabled code, .memory-footer code { font-family: Consolas, monospace; color: var(--text); }
.memory-add-row { display: flex; align-items: stretch; gap: 8px; }
.memory-input { min-height: 62px; resize: vertical; line-height: 1.45; }
.memory-add-row .primary-btn { min-width: 72px; }
.memory-review-panel { margin-top: 16px; padding: 12px; border: 1px solid rgba(217,119,87,0.45); border-radius: 9px; background: rgba(217,119,87,0.06); }
.memory-review-panel .memory-list-header { margin-top: 0; }
.memory-review-item { display: flex; gap: 12px; margin-top: 8px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); }
.memory-review-evidence { margin-top: 8px; color: var(--text-muted); font-size: 10px; line-height: 1.5; }
.memory-review-evidence summary { cursor: pointer; color: var(--accent); }
.memory-review-evidence div { margin-top: 5px; padding: 6px; border-radius: 5px; background: var(--surface); white-space: pre-wrap; }
.memory-review-toolbar, .memory-queue-status { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 9px; color: var(--text-muted); font-size: 10px; }
.memory-list-header { display: flex; align-items: baseline; justify-content: space-between; margin: 20px 0 8px; }
.memory-list-header strong { font-size: 13px; }
.memory-list-header span { color: var(--text-muted); font-size: 10px; }
.memory-list { display: flex; flex-direction: column; gap: 8px; max-height: 340px; overflow-y: auto; padding-right: 3px; }
.memory-list::-webkit-scrollbar { width: 5px; }
.memory-list::-webkit-scrollbar-thumb { border-radius: 3px; background: var(--scroll-thumb); }
.memory-item { display: flex; align-items: flex-start; gap: 12px; padding: 11px 12px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg); }
.memory-item-main { min-width: 0; flex: 1; }
.memory-item-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; color: var(--text-muted); font-size: 10px; }
.memory-kind { padding: 2px 6px; border-radius: 5px; background: var(--accent-soft); color: var(--accent); }
.memory-state { padding: 2px 5px; border-radius: 5px; background: rgba(231,76,60,0.12); color: #e76f61; }
.memory-state.active { background: rgba(45,125,70,0.13); color: var(--accent); }
.memory-state.conflicted { background: rgba(217,119,87,0.15); color: #d97757; }
.memory-content { color: var(--text); font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.memory-edit-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: start; }
.memory-edit-row > div { display: flex; flex-direction: column; gap: 6px; }
.memory-item-controls { display: grid; grid-template-columns: 0.65fr 1fr 1.2fr; gap: 7px; margin-top: 9px; }
.memory-item-controls select { display: block; margin-top: 4px; padding: 5px 6px; font-size: 9px; }
.memory-item-actions { display: flex; flex-direction: column; flex-shrink: 0; gap: 6px; }
.memory-restore-btn { padding: 6px 9px; border: 1px solid var(--accent); border-radius: 7px; background: transparent; color: var(--accent); cursor: pointer; font: inherit; font-size: 11px; }
.memory-delete-btn, .memory-purge-btn, .danger-btn { border: 1px solid rgba(231,76,60,0.45); border-radius: 7px; background: transparent; color: #e76f61; cursor: pointer; font-family: inherit; font-size: 11px; }
.memory-delete-btn { flex-shrink: 0; padding: 6px 9px; }
.memory-purge-btn { flex-shrink: 0; padding: 6px 9px; border-style: dashed; }
.memory-delete-btn.confirm, .danger-btn:hover { background: rgba(231,76,60,0.14); border-color: #e76f61; }
.memory-delete-btn:disabled, .memory-purge-btn:disabled, .danger-btn:disabled { opacity: 0.45; cursor: default; }
.memory-purge-confirm { grid-column: 1 / -1; display: grid; gap: 8px; margin-top: 10px; padding: 12px; border: 1px solid rgba(231,76,60,0.45); border-radius: 8px; background: rgba(231,76,60,0.08); color: var(--text); font-size: 12px; }
.memory-purge-confirm > div { display: flex; gap: 8px; flex-wrap: wrap; }
.memory-purge-confirm .danger-btn, .memory-purge-confirm .memory-restore-btn { padding: 7px 10px; }
.memory-footer { display: flex; align-items: center; gap: 12px; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
.memory-footer > span { flex: 1; color: var(--text-muted); font-size: 10px; }
.danger-btn { padding: 7px 10px; }

@media (max-width: 720px) {
  .memory-settings-grid, .memory-item-controls { grid-template-columns: 1fr; }
  .memory-item { flex-direction: column; }
  .memory-review-item { flex-direction: column; }
  .memory-item-actions { width: 100%; flex-direction: row; }
}

.theme-picker { position: relative; }
.theme-menu { position: absolute; top: 100%; right: 0; margin-top: 6px; z-index: 100; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 6px; min-width: 150px; box-shadow: 0 8px 24px rgba(0,0,0,0.3); }
.theme-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 6px; cursor: pointer; font-size: 13px; color: var(--text); }
.theme-item:hover { background: var(--surface-hover); }
.theme-item.active { background: var(--accent-soft); color: var(--accent); }
.theme-swatch { width: 18px; height: 18px; border-radius: 4px; flex-shrink: 0; }
.theme-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.theme-custom { margin-top: 5px; padding: 9px 10px 7px; border-top: 1px solid var(--border); color: var(--text); }
.theme-custom.active { color: var(--accent); }
.theme-custom > label { display: block; margin-bottom: 7px; font-size: 12px; font-weight: 600; }
.theme-custom-controls { display: flex; align-items: center; gap: 7px; }
.theme-custom-controls input { width: 30px; height: 26px; padding: 0; border: 1px solid var(--border); border-radius: 5px; background: transparent; cursor: pointer; }
.theme-custom-controls span { flex: 1; color: var(--text-muted); font-family: Consolas, monospace; font-size: 10px; }
.theme-custom-controls button { padding: 5px 9px; border: 1px solid var(--accent); border-radius: 6px; background: var(--accent); color: #fff; cursor: pointer; font: inherit; font-size: 11px; }
.theme-custom small { display: block; margin-top: 6px; color: var(--text-muted); font-size: 9px; white-space: nowrap; }

.chat { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 16px; }
.empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; opacity: 0.5; gap: 8px; }
.empty h1 { font-size: 28px; font-weight: 600; }

.message { display: flex; max-width: 85%; }
.message.user { align-self: flex-end; }
.message.assistant { align-self: flex-start; }
.message-body { display: flex; min-width: 0; flex-direction: column; gap: 6px; }

.bubble { padding: 10px 16px; border-radius: 14px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; font-size: 14px; }
.message.user .bubble { background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
.message.assistant .bubble { background: var(--surface); color: var(--text); border-bottom-left-radius: 4px; }
.img-tag { display: inline-block; margin-right: 6px; opacity: 0.8; }

.rollback-btn { opacity: 0; transition: opacity 0.15s; background: transparent; color: var(--text-muted); border: 1px solid var(--border); border-radius: 6px; width: 26px; height: 26px; cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; align-self: center; margin: 0 4px; }
.rollback-btn:hover { background: var(--surface); color: var(--text); border-color: var(--text-muted); }
.message:hover .rollback-btn { opacity: 1; }
.v4-internal-review { max-width: 620px; padding: 7px 9px; border: 1px dashed rgba(217,119,87,0.55); border-radius: 8px; background: rgba(217,119,87,0.07); color: var(--text-muted); font-size: 10px; }
.v4-internal-review summary { cursor: pointer; color: #d97757; font-weight: 600; }
.v4-review-warning { margin-top: 7px; line-height: 1.45; }
.v4-review-metrics { display: flex; flex-wrap: wrap; gap: 5px 10px; margin-top: 7px; }
.v4-review-candidate { margin-top: 7px; padding: 7px; border-radius: 6px; background: var(--surface); color: var(--text); line-height: 1.4; }
.v4-review-candidate small { display: block; margin-top: 4px; color: var(--text-muted); }
.v4-review-empty { margin-top: 7px; color: var(--text-muted); }
.v4-review-query-feedback { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
.v4-review-query-feedback small { width: 100%; color: #e74c3c; }
.v4-review-query-feedback button, .v4-review-feedback-actions button { padding: 3px 7px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg); color: var(--text-muted); cursor: pointer; font-size: 10px; }
.v4-review-query-feedback button:hover:not(:disabled), .v4-review-feedback-actions button:hover:not(:disabled) { border-color: var(--accent); color: var(--text); }
.v4-review-query-feedback button.selected, .v4-review-feedback-actions button.selected { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.v4-review-query-feedback button:disabled, .v4-review-feedback-actions button:disabled { cursor: default; opacity: 0.55; }
.v4-review-feedback-actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.v4-review-feedback-error { color: #e74c3c !important; }

/* Image preview */
.image-preview { display: flex; align-items: center; gap: 8px; padding: 8px 16px; background: var(--surface); border-top: 1px solid var(--border); }
.image-preview img { height: 60px; border-radius: 6px; border: 1px solid var(--border); }
.clear-img { background: transparent; color: var(--text-muted); border: none; cursor: pointer; font-size: 16px; padding: 4px; }
.clear-img:hover { color: var(--text); }

/* Voice error */
.voice-error { padding: 8px 16px; background: rgba(231,76,60,0.15); color: #e74c3c; font-size: 13px; text-align: center; border-top: 1px solid rgba(231,76,60,0.3); }

/* Input area */
.input-area { display: flex; gap: 8px; padding: 12px 16px; background: var(--bg); border-top: 1px solid var(--border); align-items: flex-end; }
.tool-btn { background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 10px; width: 42px; height: 42px; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; font-size: 18px; transition: background 0.15s; }
.tool-btn:hover { background: var(--surface-hover); }
.tool-btn:disabled { opacity: 0.4; cursor: default; }
.tool-btn.listening { animation: pulse 1.2s ease-in-out infinite; border-color: #e74c3c; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
.input-area textarea { flex: 1; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; font-size: 14px; outline: none; font-family: inherit; resize: none; max-height: 120px; }
.input-area textarea:focus { border-color: var(--accent); }
.input-help { padding: 0 20px 8px; background: var(--bg); color: var(--text-muted); font-size: 11px; }
.send-btn { background: var(--accent); color: #fff; border: none; border-radius: 10px; width: 42px; height: 42px; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background 0.15s; flex-shrink: 0; }
.send-btn:disabled { opacity: 0.4; cursor: default; }
.send-btn:not(:disabled):hover { background: var(--accent-hover); }

.chat::-webkit-scrollbar { width: 6px; }
.chat::-webkit-scrollbar-thumb { background: var(--scroll-thumb); border-radius: 3px; }
</style>
