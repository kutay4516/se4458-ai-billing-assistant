@echo off
REM One-click setup + verification for Windows. Double-click this file in the project folder.
cd /d "%~dp0"
chcp 65001 >nul
echo ===== 1/4 npm install =====
call npm install --no-audit --no-fund
if errorlevel 1 goto fail
echo ===== 2/4 npm run build =====
call npm run build
if errorlevel 1 goto fail
echo ===== 3/4 npm test =====
call npm test > docs-test-output.tmp 2>&1
type docs-test-output.tmp
if not exist docs\evidence mkdir docs\evidence
move /y docs-test-output.tmp docs\evidence\test-results.txt >nul
echo ===== 4/4 real LLM + Neon end-to-end =====
call node scripts\verify-real.mjs
echo.
echo Done. Evidence files are in docs\evidence\ (e2e-transcript.md, verify-real-summary.txt).
pause
exit /b 0
:fail
echo.
echo A step failed. Copy the text above and send it back.
pause
exit /b 1
