import { randomUUID } from 'node:crypto'
import type { createV4L2Memory } from '@continuum-memory/memory'

type Port = Pick<ReturnType<typeof createV4L2Memory>, 'reviewRelations' | 'republishRelations'>
type Options = { scope: Parameters<Port['reviewRelations']>[0]; createPort: () => Port | undefined; flush: () => void; graphEnabled: () => boolean }
const failed = (error: string) => ({ ok: false as const, error })
function errorMessage(code: string): string {
  if (code === 'scope-denied') return '当前分享权限不允许复核或发布这些关系，请检查记忆设置。'
  if (code === 'version-mismatch' || code === 'stale-projection') return '记忆、关系或权限已变化，请重新查看复核报告。'
  if (code === 'invalid-request') return '确认信息无效、已使用或已过期，请重新查看报告。'
  if (code === 'budget-exhausted') return '待复核记录过多，当前入口暂时无法处理。'
  return '复核或保存未完成，请重新查看报告后重试。'
}
function blockerMessage(reason: string): string {
  if (reason.includes('exact-endpoint-unavailable')) return '原来的事实版本已不可用，需要重新审核关系端点。'
  if (reason.includes('scope-denied')) return '来源或关系不符合当前分享权限。'
  if (reason.includes('source-unavailable')) return '原来源已更新、删除或当前不可读取。'
  if (reason.startsWith('structure:')) return '部分记录不符合当前事实版本、上下文或时间约束，需要重新审核。'
  return '记录尚未通过当前版本校验，请重新检查来源和关系。'
}

/** One desktop report at a time; the renderer cannot choose scope, reviewer or publication data. */
export function createGraphRelationReviewController(options: Options) {
  let epoch = 0, busy = false, pending: { id: string; port: Port } | undefined
  return {
    reset() { epoch++; pending = undefined },
    async preview() {
      if (busy) return failed('正在处理复核，请稍候。')
      busy = true; pending = undefined; const generation = epoch
      try {
        options.flush()
        const port = options.createPort()
        if (!port) return failed('记忆仓库尚未就绪，请启用长期记忆后重试。')
        const result = await port.reviewRelations(options.scope)
        if (epoch !== generation) return failed('记忆设置已重新加载，请重新查看报告。')
        if (!result.ok) return failed(errorMessage(result.error.code))
        const report = result.value
        if (report.canPublish && report.reviewId) pending = { id: report.reviewId, port }
        return { ok: true as const, graphEnabled: options.graphEnabled(), report: {
          reviewId: report.reviewId, expiresAt: report.expiresAt, canPublish: report.canPublish,
          candidateCount: report.candidateCount, observationCount: report.observationCount,
          relations: report.relations.map(row => ({ id: row.id, kind: row.kind, fromText: row.fromText, toText: row.toText,
            eligible: row.eligible, reasons: [...new Set(row.reasons.map(blockerMessage))] })),
          blockers: [...new Set(report.blockers.map(blockerMessage))],
        } }
      } catch { return failed('无法读取最新记忆或保存复核状态，请稍后重试。') }
      finally { busy = false }
    },
    async confirm(input: unknown) {
      if (busy) return failed('正在处理复核，请稍候。')
      if (!input || typeof input !== 'object' || Array.isArray(input)) return failed('请先查看复核报告。')
      const value = input as Record<string, unknown>
      if (Object.keys(value).some(key => !['reviewId', 'reason', 'confirmed'].includes(key))
        || typeof value.reviewId !== 'string' || typeof value.reason !== 'string'
        || !value.reason.trim() || value.reason.length > 2000 || value.confirmed !== true)
        return failed('请填写复核说明，并勾选确认。')
      if (!pending || pending.id !== value.reviewId) return failed('报告已失效，请重新查看报告。')
      const item = pending; pending = undefined; busy = true
      try {
        options.flush()
        const result = await item.port.republishRelations({ reviewId: item.id, scope: options.scope,
          operationId: `desktop-review:${randomUUID()}`, reviewer: 'desktop-local-user', reason: value.reason.trim() })
        return result.ok ? { ok: true as const, graphEnabled: options.graphEnabled() } : failed(errorMessage(result.error.code))
      } catch { return failed('发布未完成，请重新查看报告后重试。') }
      finally { busy = false }
    },
  }
}
