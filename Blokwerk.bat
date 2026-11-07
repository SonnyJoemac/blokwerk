@echo off
cd /d "%~dp0"
where node >nul 2>&1 || (echo Node.js is nodig. Installeer het via https://nodejs.org en start dit bestand opnieuw. & start "" https://nodejs.org & pause & exit /b)
if "%1"=="boot" set NO_OPEN=1
set BLOKWERK_LOOP=1
:run
node blokwerk.js
if %errorlevel%==42 goto run
pause
