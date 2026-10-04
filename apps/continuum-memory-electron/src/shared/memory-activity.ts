export interface MemoryActivityItem {
  id: string
  messageId?: string
  text: string
  createdAt: number
  pending: number
  processing: number
  clarifying: number
  failed: number
  published: number
  completed: boolean
  cancelled: number
}
export interface MemoryActivityReport {
  enabled: boolean
  items: MemoryActivityItem[]
  totals: { pending: number; processing: number; clarifying: number; failed: number; published: number }
  awaitingProcessor: number
  error?: string
}
export function memoryActivityLabel(item: MemoryActivityItem): string {
  if (item.processing) return '处理中'
  if (item.pending) return '等待整理'
  if (item.clarifying) return '待补充'
  if (item.failed) return '处理失败'
  if (item.published) return '已发布'
  if (item.completed) return '已整理'
  if (item.cancelled) return '已取消'
  return '尚未整理'
}
