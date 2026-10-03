import { expect, it } from 'vitest'
import { runL2EntityTimeRegression } from './l2-entity-time-regression'
it('preserves explicit entity constraints across time filtering and exact or semantic routes', async () => {
  const report = await runL2EntityTimeRegression()
  expect(report.tests).toBe(14)
  expect(report.checks.filter(c => !c.passed)).toEqual([])
})
