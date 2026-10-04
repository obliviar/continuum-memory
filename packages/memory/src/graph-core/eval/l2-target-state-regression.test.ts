import { expect, it } from 'vitest'
import { runL2TargetStateRegression } from './l2-target-state-regression'

it('checks explicit target states without turning them into inferred graph facts', async () => {
  const report = await runL2TargetStateRegression()
  expect(report.tests).toBe(28)
  expect(report.checks.filter(c => !c.passed)).toEqual([])
})
