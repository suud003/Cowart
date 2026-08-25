@echo off
setlocal

if not defined npm_node_execpath set "npm_node_execpath=node"
if not defined ELECTRON_BUILDER_CACHE set "ELECTRON_BUILDER_CACHE=%LOCALAPPDATA%\YogurtAIElectronBuilderCache"

call :run_builder %*
if errorlevel 1 (
  echo electron-builder failed once; retrying after Windows releases downloaded cache files...
  ping 127.0.0.1 -n 3 >nul
  call :run_builder %*
)
exit /b %ERRORLEVEL%

:run_builder
"%npm_node_execpath%" "%~dp0..\node_modules\electron-builder\out\cli\cli.js" %*
exit /b %ERRORLEVEL%
