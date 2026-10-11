@echo off
setlocal
chcp 65001 >nul
title LX→Folia 同步器卸载

set "FOLIA_HOME=%APPDATA%\Folia"
set "MOD_TARGET=%FOLIA_HOME%\mods\lx-favorites-sync"

tasklist /FI "IMAGENAME eq Folia.exe" 2>nul | find /I "Folia.exe" >nul
if not errorlevel 1 (
  echo Folia 正在运行。
  echo 请先完全退出 Folia，再运行本卸载脚本。
  pause
  exit /b 1
)

if exist "%MOD_TARGET%" (
  rmdir /s /q "%MOD_TARGET%"
  if errorlevel 1 (
    echo 删除模组失败：%MOD_TARGET%
    pause
    exit /b 1
  )
  echo 已删除模组：%MOD_TARGET%
) else (
  echo 本机没有找到已安装的 LX→Folia 同步模组。
)

echo.
echo 日志和备份没有删除：
echo %FOLIA_HOME%\lx-favorites-sync.log
echo %FOLIA_HOME%\lx-favorites-sync-backups
echo.
pause
