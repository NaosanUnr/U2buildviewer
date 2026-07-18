@echo off
rem Unrailed! 2 Build Viewer - local server launcher
cd /d "%~dp0"
start "" http://localhost:8642
node local-server.js
pause
