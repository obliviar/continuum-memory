import { expect, it } from 'vitest'
import { runL2HostRegression } from '../eval/l2-host-regression'
it('reads reviewed L2 evidence through the actual V4 host path', async () => {
  const report = await runL2HostRegression()
  expect(report.checks.filter(c => !c.passed)).toEqual([])
})
