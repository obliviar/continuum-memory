/** Yield to desktop IPC between tasks and never repeatedly select the same task. */
export async function runBackgroundTaskBatch<T>(tasks: readonly T[], isCurrent: () => boolean,
  processTask: (task: T) => Promise<boolean>): Promise<void> {
  for (const task of tasks.slice(0, 20)) {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    if (!isCurrent() || !await processTask(task)) break
  }
}
