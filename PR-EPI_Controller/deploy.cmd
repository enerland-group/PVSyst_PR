@echo off
rem ============================================================================
rem  Deploy PR-EPI_Controller to Fabric, always in sync with GitHub.
rem    1. Commits your local changes (asks first)
rem    2. Pulls your colleagues' latest changes from GitHub
rem    3. Stops if there is a conflict (nothing is deployed, nothing is lost)
rem    4. npm install, push to GitHub, then "npx rayfin up"
rem  So what goes to Fabric is always what is on GitHub, and nobody's work
rem  is overwritten.
rem ============================================================================
setlocal
cd /d "%~dp0"

where git >nul 2>&1
if errorlevel 1 (
    echo Git is not installed or not in PATH. Install it from https://git-scm.com
    goto :fail
)

rem --- Only deploy from master ---------------------------------------------------
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set "BRANCH=%%b"
if /i not "%BRANCH%"=="master" (
    echo You are on branch "%BRANCH%", not "master".
    echo Deploy only from master: merge your branch on GitHub first, then: git checkout master
    goto :fail
)

rem --- 1. Local changes -> commit ------------------------------------------------
set "STATUS_FILE=%TEMP%\pr_epi_git_status.txt"
git status --porcelain > "%STATUS_FILE%"
for %%A in ("%STATUS_FILE%") do set "STATUS_SIZE=%%~zA"
if not "%STATUS_SIZE%"=="0" (
    echo.
    echo [1/5] You have changes not yet saved in Git:
    echo ------------------------------------------------------------
    git status --short
    echo ------------------------------------------------------------
    echo These will be committed and uploaded to GitHub.
    set "MSG="
    set /p "MSG=Short description of your changes (Enter = cancel): "
    call :commit_changes
    if errorlevel 1 goto :fail
) else (
    echo [1/5] No local changes to commit.
)

rem --- 2. Pull from GitHub -------------------------------------------------------
echo.
echo [2/5] Getting your colleagues' latest changes from GitHub...
git pull --rebase origin master
if errorlevel 1 (
    git rebase --abort >nul 2>&1
    echo.
    echo *** CONFLICT: your changes and a colleague's touch the same lines. ***
    echo Nothing was deployed and nothing was lost - your commit is still here.
    echo Ask Claude to resolve it ^(or to put your work on a branch and open a pull request^).
    goto :fail
)

rem --- 3. Dependencies -----------------------------------------------------------
echo.
echo [3/5] Installing/updating packages...
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo npm install failed. Nothing was deployed.
    goto :fail
)

rem --- 4. Push to GitHub ---------------------------------------------------------
echo.
echo [4/5] Uploading to GitHub...
git push origin master
if errorlevel 1 (
    echo Push failed ^(someone may have pushed a moment ago^). Run deploy.cmd again.
    echo Nothing was deployed.
    goto :fail
)

rem --- 5. Deploy -----------------------------------------------------------------
echo.
echo [5/5] Deploying to Fabric...
call npx rayfin up
if errorlevel 1 (
    echo.
    echo Deploy failed. If your sign-in expired, run: npx rayfin login
    goto :fail
)

echo.
echo Done: GitHub and Fabric are up to date.
pause
exit /b 0

:commit_changes
if not defined MSG (
    echo Cancelled. Nothing was committed or deployed.
    exit /b 1
)
git add -A :/
git commit -m "%MSG%"
if errorlevel 1 (
    echo Commit failed. Nothing was deployed.
    exit /b 1
)
exit /b 0

:fail
echo.
pause
exit /b 1
