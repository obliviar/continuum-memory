import { expect, test } from 'vitest'
import { runOpenRecallCompatibilityRegression } from './open-recall-compatibility-regression'
test('open input navigation stays separate from canonical L1/L2 recall after merging', async () => {
  expect((await runOpenRecallCompatibilityRegression()).checks.filter(c => !c.passed)).toEqual([])
})
