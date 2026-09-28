import { expect, it } from 'vitest'
import { runDesktopGraphReviewRegression } from './graph-relation-review-regression'
it('connects desktop preview and explicit confirmation to the real relation reviewer', async () => {
  const result = await runDesktopGraphReviewRegression()
  expect(result.checks.filter(check => !check.passed)).toEqual([])
})
