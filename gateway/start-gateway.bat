@echo off
title DentB Autonomous WhatsApp Gateway
echo ===================================================
echo   DentB Autonomous WhatsApp Automation Gateway
echo   100%% Free & Unlimited Zero-Click Messaging Engine
echo ===================================================
echo.
echo Starting Gateway on http://localhost:5055 ...
echo Opening pairing dashboard in browser...
timeout /t 2 /nobreak >nul
start http://localhost:5055
cd /d "%~dp0"
node server.js
pause
