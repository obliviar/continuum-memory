import { expect, it } from 'vitest'
import { runDirectStructuredRegression } from './direct-structured-regression'

it('recalls supported self preference paraphrases without crossing slot, person or source boundaries', async () => {
  const report = await runDirectStructuredRegression()
  expect(report.tests).toBe(22)
  expect(report.checks.filter(c => !c.passed)).toEqual([])
})
