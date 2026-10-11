@echo off
setlocal
chcp 65001 >nul
title LX→Folia 同步器安装

set "SRC=%~dp0Folia-Mod"
set "FOLIA_HOME=%APPDATA%\Folia"
set "MOD_TARGET=%FOLIA_HOME%\mods\lx-favorites-sync"

if not exist "%SRC%\mod.json" (
  echo 没有找到 Folia-Mod\mod.json。
  echo 请保持“Folia-Mod”文件夹和本脚本在同一目录。
  pause
  exit /b 1
)

tasklist /FI "IMAGENAME eq Folia.exe" 2>nul | find /I "Folia.exe" >nul
if not errorlevel 1 (
  echo Folia 正在运行。
  echo 请先完全退出 Folia，再运行本安装脚本。
  pause
  exit /b 1
)

if not exist "%FOLIA_HOME%" mkdir "%FOLIA_HOME%"
if not exist "%FOLIA_HOME%\mods" mkdir "%FOLIA_HOME%\mods"
if not exist "%MOD_TARGET%" mkdir "%MOD_TARGET%"

copy /y "%SRC%\mod.json" "%MOD_TARGET%\mod.json" >nul
copy /y "%SRC%\main.cjs" "%MOD_TARGET%\main.cjs" >nul
copy /y "%SRC%\client.js" "%MOD_TARGET%\client.js" >nul
if errorlevel 1 goto fail

echo 正在启用 Folia 实验性模组系统...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Join-Path $env:APPDATA 'Folia\config.json'; if (-not (Test-Path -LiteralPath $p)) { New-Item -ItemType File -Path $p -Force | Out-Null; '{}' | Set-Content -LiteralPath $p -Encoding utf8 }; $json = Get-Content -LiteralPath $p -Raw -Encoding utf8 | ConvertFrom-Json; if ($null -eq $json.PSObject.Properties['MOD_SYSTEM_ENABLED']) { $json | Add-Member -NotePropertyName MOD_SYSTEM_ENABLED -NotePropertyValue $true } else { $json.MOD_SYSTEM_ENABLED = $true }; $text = $json | ConvertTo-Json -Depth 30; $utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false; [IO.File]::WriteAllText($p, $text, $utf8)"
if errorlevel 1 goto fail

echo.
echo 安装完成。
echo.
echo 接下来：
echo 1. 启动 Folia。
echo 2. 打开设置中的“模组”或命令面板里的“模组管理”。
echo 3. 启用“LX Music 收藏同步”，并在系统确认框中确认一次。
echo 4. 启用后会自动同步，也可以在命令面板搜索“同步 LX Music 收藏”。
echo.
pause
exit /b 0

:fail
echo.
echo 安装失败，请把上面的错误信息发给维护者。
pause
exit /b 1
