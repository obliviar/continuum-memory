import { expect, it } from 'vitest'
import { runL2ReviewRegression } from '../eval/l2-review-regression'

it('requires a current explicit review before restoring unchanged L2 records', async () => {
  const report = await runL2ReviewRegression()
  expect(report.checks.filter(check => !check.passed)).toEqual([])
})
