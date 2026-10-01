import { expect, it } from 'vitest'
import { runEntityVectorRegression } from './entity-vector-regression'
it('routes through exact L1 Entities before local L1/L2 retrieval', async () => {
  const report = await runEntityVectorRegression()
  expect(report.checks.filter(check => !check.passed)).toEqual([])
})
