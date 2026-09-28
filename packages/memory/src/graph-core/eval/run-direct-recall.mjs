// Node 24+ single-process runner for environments that cannot launch Vitest worker processes.
import './register-typescript.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
const { runDirectRecallRegression } = await import('./direct-recall-regression.ts')
const report = await runDirectRecallRegression()
const { runDirectHybridRegression } = await import('./direct-hybrid-regression.ts')
report.hybridIntegration = await runDirectHybridRegression()
const { runDirectModelHarnessRegression } = await import('./direct-model-harness-regression.ts')
report.modelHarness = await runDirectModelHarnessRegression()
const { runL1ViewRegression } = await import('./l1-view-regression.ts')
report.l1Views = await runL1ViewRegression()
const { runAcceptedL1Regression } = await import('./accepted-l1-regression.ts')
const { prepareGraphRecallInputs } = await import('../../../../../apps/continuum-memory-electron/src/main/graph-l1-recall-barrier.ts')
report.acceptedL1 = await runAcceptedL1Regression(prepareGraphRecallInputs)
const { runL2HostRegression } = await import('./l2-host-regression.ts')
const { buildGraphEvidencePrompt } = await import('../../../../core/src/prompt/graph-evidence-prompt.ts')
report.l2Host = await runL2HostRegression(buildGraphEvidencePrompt)
const { runL2LifecycleRegression } = await import('./l2-lifecycle-regression.ts')
const { withGraphSourceInvalidation } = await import('../../../../../apps/continuum-memory-electron/src/main/graph-source-invalidation.ts')
report.l2Lifecycle = await runL2LifecycleRegression(withGraphSourceInvalidation)
const { runL2ReviewRegression } = await import('./l2-review-regression.ts')
report.l2Review = await runL2ReviewRegression()
const { runDesktopGraphReviewRegression } = await import('../../../../../apps/continuum-memory-electron/src/main/graph-relation-review-regression.ts')
report.desktopReview = await runDesktopGraphReviewRegression()
console.log(JSON.stringify(report, null, 2))
if (process.env.GRAPH_RECALL_REPORT_PATH) {
  const path = process.env.GRAPH_RECALL_REPORT_PATH
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(report, null, 2), 'utf8')
}
const boundaryFailure = report.cases.some(row => !row.boundaryPassed || !row.evidencePassed
  || (row.expected.length === 0 && row.actual.length > 0))
const regressionFailure = report.cases.some(row => !row.knownGap && !row.qualityPassed) || report.lexicalChecks.some(row => !row.passed)
if (boundaryFailure || regressionFailure || report.hybridIntegration.checks.some(check => !check.passed)
  || report.modelHarness.checks.some(check => !check.passed)
  || report.l1Views.checks.some(check => !check.passed)
  || report.acceptedL1.checks.some(check => !check.passed)
  || report.l2Host.checks.some(check => !check.passed)
  || report.l2Lifecycle.checks.some(check => !check.passed)
  || report.l2Review.checks.some(check => !check.passed)
  || report.desktopReview.checks.some(check => !check.passed)
  || (process.env.GRAPH_RECALL_STRICT === '1' && report.qualityPassed !== report.tests))
  process.exitCode = 1
