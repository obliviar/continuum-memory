@echo off
setlocal
set "APP_DIR=%~dp0apps\continuum-memory-electron"
set "ELECTRON_EXE=%APP_DIR%\node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON_EXE%" (
  echo Electron is missing. Run pnpm install in the project directory.
  pause
  exit /b 1
)
if not exist "%APP_DIR%\dist\main\index.js" (
  echo Run pnpm -F @continuum-memory/electron build first.
  pause
  exit /b 1
)
if not exist "%APP_DIR%\dist\renderer\index.html" (
  echo Run pnpm -F @continuum-memory/electron build first.
  pause
  exit /b 1
)
set "ELECTRON_RUN_AS_NODE="
start "" /D "%APP_DIR%" "%ELECTRON_EXE%" "%APP_DIR%"
endlocal
