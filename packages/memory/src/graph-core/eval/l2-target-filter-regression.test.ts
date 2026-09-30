import { expect, it } from 'vitest'
import { runL2TargetFilterRegression } from './l2-target-filter-regression'

it('filters incoherent targets without treating an empty result as complete knowledge', async () => {
  const report = await runL2TargetFilterRegression()
  expect(report.tests).toBe(10)
  expect(report.checks.filter(check => !check.passed)).toEqual([])
})
