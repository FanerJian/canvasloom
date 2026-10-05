@echo off
chcp 65001 >nul
rem CanvasLoom agent 命令行入口
rem 用法示例：
rem   cli.cmd catalog
rem   cli.cmd inspect 示例页面 save_button
rem   cli.cmd apply 示例页面 --ops ops.json
rem   cli.cmd validate 示例页面 --snapshot snapshot.json
rem   cli.cmd export 示例页面
node "%~dp0cli\cli.js" %*
