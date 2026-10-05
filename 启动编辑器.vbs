' ============================================================
'  CanvasLoom silent launcher (no console window at all)
'  1. start node server hidden, output -> server.log
'  2. poll until http://127.0.0.1:8520 answers (max ~20s)
'  3. open the desktop app window (Electron shell);
'     fallback to the default browser if the shell is missing
'  Double-click the desktop shortcut; stop via 停止编辑器.cmd
'  本脚本自定位安装目录：放哪都能用，不写死安装路径。
' ============================================================
Option Explicit
Dim sh, fso, i, code, electron, root
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = root

sh.Run "cmd /c node server\server.js --port 8520 > """ & root & "\server.log"" 2>&1", 0, False

' curl ships with Windows 10 1803+; --noproxy avoids local proxy interference
For i = 1 To 80
  WScript.Sleep 250
  code = sh.Run("cmd /c curl -s --noproxy * -o NUL http://127.0.0.1:8520/api/hello", 0, True)
  If code = 0 Then Exit For
Next

electron = root & "\desktop\node_modules\electron\dist\electron.exe"
If fso.FileExists(electron) Then
  sh.Run """" & electron & """ """ & root & "\desktop""", 1, False
Else
  ' 桌面壳未安装：回退为浏览器打开网页模式（旧行为）
  sh.Run "cmd /c start """" http://127.0.0.1:8520", 0, False
End If
