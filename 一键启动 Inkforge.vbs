Option Explicit
' Inkforge one-click launcher (no console window).
' Double-click this file to start the app. If it is already running,
' the existing window is focused instead of opening a second instance.
Dim fso, sh, root, target
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
target = root & "\scripts\start.bat"
If Not fso.FileExists(target) Then
  MsgBox "scripts\start.bat not found. Please keep this file inside the Inkforge folder.", 16, "Inkforge"
  WScript.Quit 1
End If
sh.CurrentDirectory = root
' 0 = hidden window, False = do not wait for exit
sh.Run """" & target & """ --silent", 0, False
