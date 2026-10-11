@echo off
setlocal
chcp 65001 >nul
set "FOLIA_LOG=%APPDATA%\Folia\lx-favorites-sync.log"
set "FOLIA_STATUS=%APPDATA%\Folia\lx-favorites-sync-status.txt"
set "LEGACY_DIR=%ProgramData%\LX-AnyListenSync"

if exist "%FOLIA_LOG%" (
  start "" explorer.exe /select,"%FOLIA_LOG%"
  start "" notepad.exe "%FOLIA_LOG%"
  if exist "%FOLIA_STATUS%" start "" notepad.exe "%FOLIA_STATUS%"
  exit /b 0
)

if exist "%LEGACY_DIR%" (
  start "" explorer.exe "%LEGACY_DIR%"
  exit /b 0
)

echo 未找到日志文件或日志目录。
echo.
echo Folia 日志：%FOLIA_LOG%
echo Folia 状态：%FOLIA_STATUS%
echo 旧版日志目录：%LEGACY_DIR%
pause
