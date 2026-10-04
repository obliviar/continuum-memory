import { expect, test } from 'vitest'
import { runCrossEncoderRegression } from './cross-encoder-regression'
test('local cross-encoder adapter validates scores and reuses only identical candidates', async () => {
  expect((await runCrossEncoderRegression()).checks.filter(c => !c.passed)).toEqual([])
})
