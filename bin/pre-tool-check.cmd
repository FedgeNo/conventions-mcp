@echo off
node "%~dp0pre-tool-check.js" %*
exit /b %errorlevel%
