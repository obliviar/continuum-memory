import { expect, it } from 'vitest'
import { runL2SemanticFallbackRegression } from './l2-semantic-fallback-regression'

it('admits only a separated semantic fallback with complete eligible vectors', async () => {
  const report = await runL2SemanticFallbackRegression()
  expect(report.tests).toBe(15)
  expect(report.checks.filter(check => !check.passed)).toEqual([])
})
