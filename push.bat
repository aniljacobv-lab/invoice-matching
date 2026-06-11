@echo off
REM Stage, commit, push. Triggers a Render auto-redeploy.
REM Usage:  push.bat "your message"
setlocal
cd /d "%~dp0"
set "MSG=%~1"
if "%MSG%"=="" set "MSG=Update %DATE% %TIME%"
git add -A
git diff --cached --quiet
if not errorlevel 1 ( echo Nothing to commit. & exit /b 0 )
git commit -m "%MSG%"
if errorlevel 1 ( echo Commit failed. & exit /b %errorlevel% )
git push
if errorlevel 1 ( echo Push failed. Try: git pull --rebase & exit /b %errorlevel% )
echo Pushed: "%MSG%"
echo Render will redeploy in ~2-3 min.
