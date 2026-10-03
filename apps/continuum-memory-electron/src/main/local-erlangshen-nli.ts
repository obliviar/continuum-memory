import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { GraphNliJudgePort } from '@continuum-memory/memory'

export const ERLANGSHEN_NLI_MODEL_ID = 'IDEA-CCNL/Erlangshen-Roberta-330M-NLI'
export const ERLANGSHEN_NLI_PREPROCESSING_VERSION = 'erlangshen-pair-256-v1'

export interface LocalErlangshenOptions {
  pythonPath: string
  scriptPath: string
  modelPath: string
  dependenciesPath?: string
  modelRevision: string
  preprocessingVersion?: string
  startupTimeoutMs?: number
  requestTimeoutMs?: number
}

export function createLocalErlangshenNli(options: LocalErlangshenOptions): GraphNliJudgePort & { close: () => void; isReady: () => boolean } {
  let child: ChildProcessWithoutNullStreams | undefined
  let starting: Promise<void> | undefined
  let buffer = ''
  let sequence = 0
  let readyResolve: (() => void) | undefined
  let readyReject: ((error: Error) => void) | undefined
  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()

  function stop(error: Error): void {
    const previous = child
    child = undefined
    starting = undefined
    readyReject?.(error)
    readyResolve = undefined
    readyReject = undefined
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error) }
    pending.clear()
    if (previous && !previous.killed) previous.kill()
  }

  function consume(line: string): void {
    let message: Record<string, unknown>
    try { message = JSON.parse(line) as Record<string, unknown> }
    catch { stop(new Error('Local Erlangshen NLI returned invalid JSON')); return }
    if (message.ready === true) {
      if (message.modelId !== ERLANGSHEN_NLI_MODEL_ID || message.modelRevision !== options.modelRevision) {
        stop(new Error('Local Erlangshen NLI model revision mismatch'))
        return
      }
      readyResolve?.()
      readyResolve = undefined
      readyReject = undefined
      return
    }
    if (typeof message.id !== 'string') return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (typeof message.error === 'string') request.reject(new Error(message.error))
    else request.resolve(message)
  }

  async function start(): Promise<void> {
    if (child && starting) return starting
    if (!existsSync(options.pythonPath) || !existsSync(options.scriptPath) || !existsSync(options.modelPath))
      throw new Error('Local Erlangshen NLI runtime or model is unavailable')
    buffer = ''
    const env = { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONIOENCODING: 'utf-8',
      ...(options.dependenciesPath ? { PYTHONPATH: [options.dependenciesPath, process.env.PYTHONPATH]
        .filter(Boolean).join(process.platform === 'win32' ? ';' : ':') } : {}) }
    child = spawn(options.pythonPath, [options.scriptPath, '--model-path', options.modelPath], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env,
    })
    const processRef = child
    starting = new Promise<void>((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
      const timer = setTimeout(() => stop(new Error('Local Erlangshen NLI startup timed out')),
        options.startupTimeoutMs ?? 180_000)
      const originalResolve = readyResolve
      const originalReject = readyReject
      readyResolve = () => { clearTimeout(timer); originalResolve() }
      readyReject = error => { clearTimeout(timer); originalReject(error) }
    })
    processRef.stdout.setEncoding('utf8')
    processRef.stdout.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > 1_000_000) { stop(new Error('Local Erlangshen NLI output exceeded limit')); return }
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) consume(line)
        index = buffer.indexOf('\n')
      }
    })
    let stderr = ''
    processRef.stderr.setEncoding('utf8')
    processRef.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-1000) })
    processRef.on('error', error => stop(error))
    processRef.on('close', code => {
      if (child === processRef)
        stop(new Error(`Local Erlangshen NLI exited (${code ?? 'unknown'}): ${stderr.slice(-300)}`))
    })
    return starting
  }

  return {
    isReady: () => existsSync(options.pythonPath) && existsSync(options.scriptPath) && existsSync(options.modelPath),
    close: () => stop(new Error('Local Erlangshen NLI stopped')),
    async judge(request) {
      try {
        await start()
        const id = String(++sequence)
        const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id)
            stop(new Error('Local Erlangshen NLI inference timed out'))
            reject(new Error('Local Erlangshen NLI inference timed out'))
          }, options.requestTimeoutMs ?? 60_000)
          pending.set(id, { resolve, reject, timer })
          child!.stdin.write(JSON.stringify({ id, premise: request.premise.text,
            hypothesis: request.hypothesisText }) + '\n')
        })
        const scores = result.scores as Record<'CONTRADICTION' | 'NEUTRAL' | 'ENTAILMENT', number>
        if (!scores || !['CONTRADICTION', 'NEUTRAL', 'ENTAILMENT'].every(label =>
          Number.isFinite(scores[label as keyof typeof scores])))
          throw new Error('Local Erlangshen NLI returned invalid scores')
        if (result.modelId !== ERLANGSHEN_NLI_MODEL_ID || result.modelRevision !== options.modelRevision)
          throw new Error('Local Erlangshen NLI response revision mismatch')
        return { ok: true as const, value: { scores, modelId: ERLANGSHEN_NLI_MODEL_ID,
          modelRevision: options.modelRevision,
          preprocessingVersion: options.preprocessingVersion ?? ERLANGSHEN_NLI_PREPROCESSING_VERSION,
          truncated: result.truncated === true } }
      }
      catch (error) {
        return { ok: false as const, error: { code: 'not-ready' as const,
          message: error instanceof Error ? error.message : 'Local Erlangshen NLI failed' } }
      }
    },
  }
}
