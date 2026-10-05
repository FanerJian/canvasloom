@echo off
chcp 65001 >nul
rem ============================================================
rem  CanvasLoom 界面工坊 —— 停止后台编辑器
rem  精确结束监听 8520 端口的进程，不影响其他 Node 程序。
rem ============================================================
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 8520 -State Listen -ErrorAction SilentlyContinue; if ($c) { $c | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; Write-Host '[CanvasLoom] 编辑器已停止。' } else { Write-Host '[CanvasLoom] 编辑器未在运行。' }"
pause
