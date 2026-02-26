@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "REPO_URL=https://github.com/mxnix/AIClient-2-API"
set "REPO_NAME=AIClient-2-API"
set "PROJECT_DIR="
set "REMOTE_URL="

for %%I in ("%~dp0.") do set "SCRIPT_DIR=%%~fI"
for %%I in ("%CD%") do set "CURRENT_DIR=%%~fI"

echo [AIO] Starting AIO script for Windows.

where git >nul 2>&1
if errorlevel 1 (
    echo [AIO][ERROR] git not found.
    echo [AIO] Install Git: https://git-scm.com/download/win
    pause
    exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
    echo [AIO][ERROR] Node.js not found.
    echo [AIO] Install Node.js LTS: https://nodejs.org/
    pause
    exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
    echo [AIO][ERROR] npm not found.
    echo [AIO] Reinstall Node.js. npm is included with Node.js: https://nodejs.org/
    pause
    exit /b 1
)

call :is_target_repo "%CURRENT_DIR%"
if !errorlevel! equ 0 (
    set "PROJECT_DIR=%CURRENT_DIR%"
) else (
    call :is_target_repo "%SCRIPT_DIR%"
    if !errorlevel! equ 0 (
        set "PROJECT_DIR=%SCRIPT_DIR%"
    ) else (
        set "PROJECT_DIR=%CURRENT_DIR%\%REPO_NAME%"
    )
)

echo [AIO] Project directory: %PROJECT_DIR%

if exist "%PROJECT_DIR%\.git" (
    echo [AIO] Repository found. Updating...
    git -C "%PROJECT_DIR%" fetch --all --prune
    if errorlevel 1 (
        echo [AIO][ERROR] Failed to run git fetch.
        pause
        exit /b 1
    )

    git -C "%PROJECT_DIR%" pull --ff-only
    if errorlevel 1 (
        echo [AIO][WARN] git pull --ff-only failed. Continuing with local state.
    )
) else (
    if exist "%PROJECT_DIR%" (
        echo [AIO][ERROR] Folder "%PROJECT_DIR%" exists but is not a git repository.
        echo [AIO] Rename or remove the folder and run again.
        pause
        exit /b 1
    )

    echo [AIO] Cloning repository %REPO_URL% ...
    git clone "%REPO_URL%" "%PROJECT_DIR%"
    if errorlevel 1 (
        echo [AIO][ERROR] Failed to clone repository.
        pause
        exit /b 1
    )
)

if not exist "%PROJECT_DIR%\package.json" (
    echo [AIO][ERROR] package.json not found in "%PROJECT_DIR%".
    pause
    exit /b 1
)

cd /d "%PROJECT_DIR%"

echo [AIO] Running npm install...
call npm install
if errorlevel 1 (
    echo [AIO][ERROR] npm install failed.
    pause
    exit /b 1
)

echo [AIO] Running npm start...
call npm start
exit /b %errorlevel%

:is_target_repo
set "CHECK_DIR=%~1"
set "REMOTE_URL="

if not exist "%CHECK_DIR%\.git" exit /b 1

for /f "delims=" %%R in ('git -C "%CHECK_DIR%" config --get remote.origin.url 2^>nul') do (
    set "REMOTE_URL=%%R"
)

if not defined REMOTE_URL exit /b 1

echo !REMOTE_URL! | findstr /i "mxnix/AIClient-2-API" >nul
if errorlevel 1 (
    exit /b 1
) else (
    exit /b 0
)
