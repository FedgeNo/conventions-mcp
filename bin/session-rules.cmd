@echo off
node "%~dp0session-rules.js" %*
exit /b %errorlevel%
