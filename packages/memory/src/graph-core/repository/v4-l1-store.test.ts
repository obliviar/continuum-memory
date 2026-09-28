import { expect, it } from 'vitest'
import { runL1ViewRegression } from '../eval/l1-view-regression'

it('publishes stable L1 views and enforces exact-version lifecycle checks', async () => {
  const report = await runL1ViewRegression()
  expect(report.checks.filter(check => !check.passed)).toEqual([])
})
