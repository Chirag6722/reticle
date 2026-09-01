@echo off
rem reticle setup — the whole of SKILL.md's SETUP in one call, on Windows.
rem
rem   setup\reticle.cmd [--app dir] [--url url] [--json] ...   (see reticle.mjs for every flag)
rem
rem The sibling of reticle.sh, and a LAUNCHER for the same reticle.mjs — there is still exactly one
rem implementation. It exists because the .sh cannot run here: a stock Windows box has no `sh`, it
rem needs Git Bash or WSL, and Windows is most of Reticle's users. Telling them to type
rem `node setup/reticle.mjs` while every doc and every other platform says `./setup/reticle.sh` is
rem a worse answer than four lines of batch that do the same two checks first.
rem
rem The checks are the point. Both refusals below can be the ONLY thing a caller ever sees, because
rem they happen before Node runs the module that would otherwise produce the result object — and a
rem Node old enough (12 and under) cannot PARSE reticle.mjs, so the guard inside it never runs and
rem the user gets a SyntaxError instead of a reason.
setlocal

where node >nul 2>&1
if errorlevel 1 (
  echo reticle setup needs Node ^(it is what your app's own dev server runs on^): https://nodejs.org 1>&2
  exit /b 1
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)" 2>nul
if errorlevel 1 (
  echo reticle setup needs Node 18 or newer. 1>&2
  echo Node 16 and older have no global fetch, so setup would edit your build config and then die halfway through. 1>&2
  exit /b 1
)

rem %~dp0 is this file's own directory, with a trailing backslash, so the script is found however
rem the caller reached it — a relative path, a different drive, or a shortcut.
node "%~dp0reticle.mjs" %*
exit /b %errorlevel%
