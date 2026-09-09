@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

echo.
echo =======================================================
echo              ⚡ KasRAI Gateway Setup ⚡
echo          Kasper Route AI Windows Installer
echo =======================================================
echo.

set "REPO_URL=https://github.com/kasper-studios/KasRAI.git"
set "INSTALL_DIR=%USERPROFILE%\KasRAI"

:: Check Git
where git >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [Installer] ❌ Git is not installed or not in PATH!
    echo [Installer] Please install Git for Windows: https://git-scm.com/
    pause
    exit /b 1
)

:: Check Node.js
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [Installer] ❌ Node.js is not installed or not in PATH!
    echo [Installer] Please install Node.js 18+ from: https://nodejs.org/
    pause
    exit /b 1
)

echo [Installer] ✅ Node.js and Git detected!

:: Clone or Update
if exist "%INSTALL_DIR%\.git" (
    echo [Installer] 🔄 KasRAI already exists at %INSTALL_DIR%. Updating...
    cd /d "%INSTALL_DIR%"
    git pull origin main
) else (
    echo [Installer] 📥 Cloning KasRAI repository into %INSTALL_DIR%...
    git clone "%REPO_URL%" "%INSTALL_DIR%"
    cd /d "%INSTALL_DIR%"
)

:: Install Dependencies
echo [Installer] 📦 Installing dependencies (Zero-native, pure JavaScript)...
call npm install --omit=dev --no-audit --no-fund

echo.
echo =======================================================
echo        🎉 KasRAI Successfully Installed! 🎉
echo =======================================================
echo.
echo To launch KasRAI anytime:
echo   cd %INSTALL_DIR% ^&^& node server.js
echo.
echo Dashboard URL:
echo   👉 http://localhost:20250/
echo.

set /p START_NOW="🚀 Launch KasRAI now? (y/n): "
if /i "%START_NOW%"=="y" (
    echo [Installer] Starting KasRAI Gateway on port 20250...
    start http://localhost:20250/
    node server.js
)

pause
