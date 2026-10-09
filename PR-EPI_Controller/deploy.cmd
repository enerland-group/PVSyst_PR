@echo off
rem Deploys the app to Fabric (builds and uploads). Run "npm install" first only when package.json changes.
cd /d "%~dp0"
call npx rayfin up
if errorlevel 1 echo. & echo Deploy failed. If your sign-in expired, run: npx rayfin login
pause
