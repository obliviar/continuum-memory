import { expect, it } from 'vitest'
import { runDirectHybridRegression } from '../eval/direct-hybrid-regression'

it('preserves source, privacy and budget boundaries with semantic candidates', async () => {
  const report = await runDirectHybridRegression()
  expect(report.checks.filter(check => !check.passed)).toEqual([])
})
