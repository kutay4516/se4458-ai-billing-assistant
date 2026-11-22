@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Azure deploy (Container Apps) ===
where az >/dev/null 2>/dev/null || (echo Azure CLI not found. Install: https://aka.ms/installazurecliwindows then open a new terminal & pause & exit /b 1)
if not exist node_modules (call npm ci)
call node scripts\deploy-azure.mjs
echo.
echo Exit code: %ERRORLEVEL%
pause
