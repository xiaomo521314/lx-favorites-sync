@echo off
setlocal
chcp 65001 >nul
set "STATUS=%APPDATA%\Folia\lx-favorites-sync-status.txt"
if exist "%STATUS%" (
  start "" explorer.exe /select,"%STATUS%"
  start "" notepad.exe "%STATUS%"
) else if exist "%APPDATA%\Folia\lx-favorites-sync.log" (
  start "" notepad.exe "%APPDATA%\Folia\lx-favorites-sync.log"
) else (
  echo 还没有同步状态或日志文件。
  echo 请先启动 Folia，并执行一次“同步 LX Music 收藏”。
  echo.
  echo 状态文件：%STATUS%
  pause
)
