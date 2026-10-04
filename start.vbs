Option Explicit
Dim shell, files, projectDir, appDir, electronExe, env
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
projectDir = files.GetParentFolderName(WScript.ScriptFullName)
appDir = files.BuildPath(projectDir, "apps\continuum-memory-electron")
electronExe = files.BuildPath(appDir, "node_modules\electron\dist\electron.exe")
If Not files.FileExists(electronExe) Then
  MsgBox "Electron is missing. Run pnpm install in the project directory.", 16, "Continuum Memory"
  WScript.Quit 1
End If
If Not files.FileExists(files.BuildPath(appDir, "dist\main\index.js")) Or Not files.FileExists(files.BuildPath(appDir, "dist\renderer\index.html")) Then
  MsgBox "The desktop app has not been built. Run pnpm -F @continuum-memory/electron build in the project directory.", 16, "Continuum Memory"
  WScript.Quit 1
End If
Set env = shell.Environment("Process")
env.Remove "ELECTRON_RUN_AS_NODE"
shell.CurrentDirectory = appDir
shell.Run Chr(34) & electronExe & Chr(34) & " " & Chr(34) & appDir & Chr(34), 1, False
