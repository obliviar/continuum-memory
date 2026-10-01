import { expect, test } from 'vitest'
import { runCandidateSelectionRegression } from './candidate-selection-regression'
test('candidate selection, diagnostics and cross-topic fixture boundaries', async () => {
  const report = await runCandidateSelectionRegression()
  expect(report.checks.filter(c => !c.passed)).toEqual([])
})
