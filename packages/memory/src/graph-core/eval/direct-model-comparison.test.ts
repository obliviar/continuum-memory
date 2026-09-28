import { expect, it } from 'vitest'
import { runDirectModelHarnessRegression } from './direct-model-harness-regression'

it('compares unchanged gold evidence and never labels degraded runs as model success', async () => {
  const report = await runDirectModelHarnessRegression()
  expect(report.checks.filter(check => !check.passed)).toEqual([])
})
