param(
  [string]$DependencyDirectory = 'D:\Models\UIE-mini\.venv-paddle\Lib\site-packages',
  [switch]$PositiveControlOnly
)
$ErrorActionPreference = 'Stop'
$trialRoot = Split-Path -Parent $PSScriptRoot
$trialDirectory = Join-Path $trialRoot 'tmp/local-uie-test'
$trialPython = Join-Path $trialDirectory 'venv/Scripts/python.exe'
$trialModel = Join-Path $trialDirectory 'model'
if (!(Test-Path -LiteralPath $trialPython) -or !(Test-Path -LiteralPath (Join-Path $trialModel 'model_state.pdparams'))) {
  throw '独立测试解释器或模型副本不存在；请先按测试报告准备环境。'
}
if (!(Test-Path -LiteralPath $DependencyDirectory)) { throw '测试依赖目录不存在。' }
$trialEnvironment = @{
  PYTHONPATH = $DependencyDirectory
  PYTHONDONTWRITEBYTECODE = '1'
  PPNLP_HOME = (Join-Path $trialDirectory 'paddlenlp-home')
  HF_HUB_OFFLINE = '1'
  CONTINUUM_TEST_LOCAL_OPEN_UIE = '1'
  CONTINUUM_MEMORY_UIE_PYTHON = $trialPython
  CONTINUUM_MEMORY_UIE_MODEL_PATH = $trialModel
  CONTINUUM_MEMORY_UIE_SCRIPT_PATH = (Join-Path $PSScriptRoot 'uie_local_test_bridge.py')
}
$trialPrevious = @{}
foreach ($key in $trialEnvironment.Keys) {
  $trialPrevious[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
  [Environment]::SetEnvironmentVariable($key, $trialEnvironment[$key], 'Process')
}
Push-Location (Join-Path $trialRoot 'packages/memory')
try {
  $trialArguments = @('node_modules/vitest/vitest.mjs', 'run', 'src/eval/uie-open-strategy-probe.test.ts', '--no-file-parallelism')
  if ($PositiveControlOnly) { $trialArguments += @('-t', 'concrete-target positive control') }
  & node @trialArguments
  if ($LASTEXITCODE -ne 0) { throw "UIE实验失败，退出码$LASTEXITCODE；不要将其视为提取成功。" }
} finally {
  Pop-Location
  foreach ($key in $trialPrevious.Keys) {
    [Environment]::SetEnvironmentVariable($key, $trialPrevious[$key], 'Process')
  }
}
