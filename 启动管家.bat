@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Aether Companion - ARTVAS Local Video Bridge

REM ============================================================
REM  Robust launcher (ASCII-only on purpose).
REM  Why ASCII: a UTF-8 .bat with Chinese inside if(...) blocks +
REM  chcp can mis-parse under the GBK console and skip the final
REM  pause -> the window flashes and closes before you can read
REM  the error. Keeping THIS file ASCII removes that whole class
REM  of failure. Rich Chinese guidance (incl. the first-run setup
REM  wizard) is printed by node itself (Node handles UTF-8 fine).
REM  Every exit path routes to :hold so the window never vanishes.
REM ============================================================

REM --- 1) Node.js present in PATH (double-click uses the SYSTEM PATH) ? ---
where node >nul 2>nul
if errorlevel 1 goto :no_node

REM --- 2) ensure a config.json exists (empty values are fine: the in-app
REM        wizard will install kling / log in / bind the connect-code).  ---
if not exist "config.json" if exist "config.example.json" copy /y "config.example.json" "config.json" >nul

REM --- 3) register the aether-companion:// URL protocol (idempotent, HKCU/no-admin) ---
REM  Lets the in-canvas / settings "one-click connect" button wake + bind this companion.
node src\index.js --register-protocol >nul 2>nul

REM --- 4) run the companion (foreground; closing window stops it) ---
REM  First run with empty config -> Node prints an interactive setup wizard
REM  (detect/install kling, kling login, bind connect-code). Just follow it.
REM  %* forwards TRUSTED manual/debug args only (e.g. --once / --doctor / --setup
REM  typed by a human). The aether-companion:// protocol invokes node.exe DIRECTLY
REM  (see protocol.js / ADR-0149 5.10 C1), so an untrusted URL never reaches %* here.
echo Starting Aether Companion...
echo Keep this window OPEN. Closing it stops the companion.
echo First run? Just follow the on-screen setup wizard below.
echo ------------------------------------------------------------
echo.
node src\index.js %*
set "_CODE=%errorlevel%"
echo.
echo ------------------------------------------------------------
echo Companion stopped. exit code = %_CODE%
echo If it exited right away, read the messages above for the reason.
goto :hold

:no_node
echo.
echo ============================================================
echo  Node.js is required (install once)
echo   1) Open https://nodejs.org
echo   2) Install the LTS version (20.x recommended)
echo   3) After install, double-click this file again
echo  Note: if "node -v" works in your terminal but this window
echo  still says missing, Node is not on the SYSTEM PATH used by
echo  double-click. Reinstall Node "for all users", then retry.
echo ============================================================
goto :hold

:hold
echo.
echo Press any key to close this window.
pause >nul
exit /b
