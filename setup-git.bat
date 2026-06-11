@echo off
REM One-time GitHub setup for Invoice Matching.
REM Usage:  setup-git.bat https://github.com/<your-username>/invoice-matching.git
setlocal
cd /d "%~dp0"

if "%~1"=="" (
  echo Usage: setup-git.bat ^<github-repo-url^>
  echo Example: setup-git.bat https://github.com/your-username/invoice-matching.git
  exit /b 1
)
where git >nul 2>nul
if errorlevel 1 ( echo Git is not on PATH. Install from https://git-scm.com/download/win & exit /b 1 )
if exist ".git" ( echo Already a git repo. To switch remote: git remote set-url origin %~1 & exit /b 1 )

echo Initializing repo...
git init
git branch -M main
git add -A
git -c user.email="anil@invoice-matching.local" -c user.name="Anil" commit -m "Initial commit: Invoice Matching POC"
if errorlevel 1 ( echo Commit failed. Set git identity then retry. & exit /b 1 )
git remote add origin "%~1"
git push -u origin main
if errorlevel 1 ( echo Push failed. Check GitHub credentials and that repo is empty. & exit /b 1 )

echo.
echo Done! Repo pushed. Now connect Render: https://dashboard.render.com/select-repo
