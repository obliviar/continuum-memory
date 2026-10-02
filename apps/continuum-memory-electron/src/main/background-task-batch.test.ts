import { describe, expect, it } from 'vitest'
import { runBackgroundTaskBatch } from './background-task-batch'

describe('desktop background task batch', () => {
  it('bounds a drain and lets desktop events run between tasks', async () => {
    const processed: number[] = []
    let eventRan = false
    setTimeout(() => { eventRan = true }, 0)
    await runBackgroundTaskBatch(Array.from({ length: 100 }, (_, i) => i), () => true, async task => {
      expect(eventRan).toBe(true)
      processed.push(task)
      return true
    })
    expect(processed).toHaveLength(20)
    expect(new Set(processed).size).toBe(20)
  })
  it('stops when a missing Claim is deferred instead of selecting it again', async () => {
    const processed: number[] = []
    await runBackgroundTaskBatch([1, 2], () => true, async task => {
      processed.push(task)
      return false
    })
    expect(processed).toEqual([1])
  })
  it('discards the batch after memory is reinitialized', async () => {
    let current = true
    const processed: number[] = []
    await runBackgroundTaskBatch([1, 2], () => current, async task => {
      processed.push(task)
      current = false
      return true
    })
    expect(processed).toEqual([1])
  })
})
