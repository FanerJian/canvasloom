@echo off
chcp 65001 >nul
rem ============================================================
rem  CanvasLoom 界面工坊 —— 控制台调试启动
rem  日常使用请双击桌面快捷方式（走 启动编辑器.vbs，无黑窗口）；
rem  本文件用于排障：能看到服务日志，关闭本窗口即退出编辑器。
rem ============================================================
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [CanvasLoom] 未找到 Node.js，请先安装 Node.js 18 或更高版本。
  pause
  exit /b 1
)
echo [CanvasLoom] 正在启动编辑器 http://127.0.0.1:8520 （关闭本窗口即退出）...
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start "" http://127.0.0.1:8520"
node server\server.js --port 8520
pause
