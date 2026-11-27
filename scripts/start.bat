@echo off
rem Inkforge one-click launcher.
rem ASCII-only on purpose: cmd may read this file with a legacy code page, and
rem non-ASCII bytes there would break parsing.
rem
rem Usage:
rem   start.bat            visible console (good for troubleshooting)
rem   start.bat --silent   no console; errors go to %LOCALAPPDATA%\Inkforge\start.log
rem   start.bat --check    only verify environment and build output, do not launch
setlocal EnableExtensions
cd /d "%~dp0.."

set "SILENT="
set "CHECKONLY="
if /i "%~1"=="--silent" set "SILENT=1"
if /i "%~1"=="--check" set "CHECKONLY=1"
set "LOGDIR=%LOCALAPPDATA%\Inkforge"
set "LOGFILE=%LOGDIR%\start.log"
if not exist "%LOGDIR%" md "%LOGDIR%" >nul 2>nul

where node >nul 2>nul
if errorlevel 1 goto no_node

if not exist "node_modules\electron" goto install_deps
if not exist "out\main\main.js" goto build_app
goto ready

:install_deps
call :say "Installing dependencies, this may take a few minutes..."
where pnpm >nul 2>nul
if errorlevel 1 goto try_corepack
call pnpm install
if errorlevel 1 goto install_failed
goto after_install

:try_corepack
where corepack >nul 2>nul
if errorlevel 1 goto use_npm
call corepack pnpm install
if errorlevel 1 goto install_failed
goto after_install

:use_npm
call npm install
if errorlevel 1 goto install_failed

:after_install
if exist "node_modules\electron" goto build_app
goto install_failed

:build_app
call :say "Building application..."
node "node_modules\electron-vite\bin\electron-vite.js" build
if errorlevel 1 goto build_failed
if not exist "out\main\main.js" goto build_failed

:ready
if defined CHECKONLY (
  call :say "Environment looks good (node, dependencies, build output)."
  exit /b 0
)
call :say "Starting Inkforge..."
node "scripts\launch.cjs"
if errorlevel 1 goto launch_failed
exit /b 0

:no_node
call :say "Node.js not found. Install Node.js 22 or newer from https://nodejs.org/"
exit /b 1

:install_failed
call :say "Dependency installation failed."
exit /b 1

:build_failed
call :say "Build failed."
exit /b 1

:launch_failed
call :say "Application exited with an error."
exit /b 1

:say
echo [Inkforge] %~1
if defined SILENT echo [%DATE% %TIME%] %~1>>"%LOGFILE%"
goto :eof
