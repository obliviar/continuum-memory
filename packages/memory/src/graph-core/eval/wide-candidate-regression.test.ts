import { expect, test } from 'vitest'
import { runWideCandidateRegression } from './wide-candidate-regression'
test('wide local candidates require a separate evidence decision', async () => {
  expect((await runWideCandidateRegression()).checks.filter(c => !c.passed)).toEqual([])
})
