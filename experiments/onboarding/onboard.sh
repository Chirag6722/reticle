#!/usr/bin/env bash
# reticle onboard — the whole of SKILL.md's SETUP in one shell run.
#
# The 20 minutes is not compute. It is ~15 serialised model turns (read report, decide, run,
# read again) plus one human round trip for the MCP restart. This collapses the turns into one
# call, overlaps what can overlap, and deletes the restart by doing the final drive in a FRESH
# `claude -p` process — a new process reads the MCP server list at startup, so it has the
# reticle_* tools the calling session is still missing.
#
# Output is one AGENT: line per thing the caller must act on, and a TIMING: block at the end.
#
# Usage: bash onboard.sh [--app <dir>] [--url <url>] [--no-restart-dev] [--no-drive] [--relaunch]
set -uo pipefail

APP=""; URL=""; RESTART_DEV=1; DRIVE=1; RELAUNCH=0
while (( $# )); do
  case "$1" in
    --app) APP="$2"; shift 2;;
    --url) URL="$2"; shift 2;;
    --no-restart-dev) RESTART_DEV=0; shift;;
    --no-drive) DRIVE=0; shift;;
    --relaunch) RELAUNCH=1; shift;;
    *) echo "unknown flag: $1" >&2; exit 2;;
  esac
done

T0=$(date +%s); PHASE_LOG=""
mark() { PHASE_LOG="${PHASE_LOG}  $1: $(( $(date +%s) - T0 ))s\n"; }
say()  { printf '%s\n' "$*"; }
die()  { say "AGENT: $*"; say "TIMING:"; printf "%b" "$PHASE_LOG"; exit 1; }

PORT="${RETICLE_PORT:-4400}"
STATUS="http://127.0.0.1:$PORT/status"
LOG_DIR=".reticle"; mkdir -p "$LOG_DIR"
DEV_LOG="$LOG_DIR/onboard-dev.log"

# --- phase 1: prefetch the CLI while we read package.json ------------------------------------
# npx downloading @reticlehq/server is the one genuinely parallelisable wait in the whole flow.
npx --yes @reticlehq/server@latest --version >/dev/null 2>&1 &
PREFETCH=$!

PKG="${APP:-.}/package.json"
[ -f "$PKG" ] || die "no package.json at $PKG — nothing to instrument."
DEV_SCRIPT=$(node -p "const s=require('$PWD/$PKG').scripts||{};['dev','start','serve'].find(k=>s[k])||''")
[ -n "$DEV_SCRIPT" ] || die "no dev/start/serve script in $PKG. SKILL.md says stop here rather than invent one."
PM=pnpm; [ -f pnpm-lock.yaml ] || { [ -f yarn.lock ] && PM=yarn || { [ -f bun.lockb ] && PM=bun || PM=npm; }; }

wait $PREFETCH; mark "prefetch+detect"

# --- phase 2: init ---------------------------------------------------------------------------
INIT_OUT="$LOG_DIR/onboard-init.log"
RETICLE_INSTALL_SOURCE=onboard_script npx --yes @reticlehq/server@latest init ${APP:+--app "$APP"} >"$INIT_OUT" 2>&1
INIT_RC=$?
grep -E '^\s*[⚠ℹ]' "$INIT_OUT" | while read -r l; do say "AGENT: init needs you — $l"; done
[ -f .reticle.json ] || die "init exited $INIT_RC and wrote no .reticle.json — read $INIT_OUT."
mark "init"

# --- phase 3: the dev server, restarted so the new build config is actually in the bundle -----
# A dev server that was already running read vite.config/next.config BEFORE init edited it. It
# keeps serving the old bundle, no session ever appears, and every symptom points at the wiring.
# This is SKILL.md's one sanctioned kill: our repo's own dev server, and only its own.
if [ -z "$URL" ]; then
  if (( RESTART_DEV )); then
    for p in 3000 3001 4321 5173 5174 8080; do
      pid=$(lsof -ti "tcp:$p" -sTCP:LISTEN 2>/dev/null | head -1) || continue
      [ -n "$pid" ] || continue
      # only ours: the listener's cwd must be inside this repo.
      cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
      case "$cwd" in "$PWD"*) say "restarting stale dev server (pid $pid, port $p, pre-init bundle)"; kill "$pid" 2>/dev/null;; esac
    done
  fi
  say "starting: $PM run $DEV_SCRIPT  (background, log: $DEV_LOG)"
  ( cd "${APP:-.}" && $PM run "$DEV_SCRIPT" ) >"$DEV_LOG" 2>&1 &
  DEV_PID=$!
  # The dev tool prints its own URL; never compose one — the port is its business, not ours.
  for _ in $(seq 1 120); do
    URL=$(grep -oE 'https?://(localhost|127\.0\.0\.1):[0-9]+' "$DEV_LOG" | head -1) && [ -n "$URL" ] && break
    kill -0 $DEV_PID 2>/dev/null || die "dev server exited — read $DEV_LOG."
    sleep 0.5
  done
  [ -n "$URL" ] || die "dev server printed no URL in 60s — read $DEV_LOG."
fi
say "app: $URL"
mark "dev-server"

# --- phase 4: open a tab and gate on a real session -------------------------------------------
npx --yes @reticlehq/server@latest open "$URL" >/dev/null 2>&1 || true
SESSION=""
for _ in $(seq 1 60); do
  SESSION=$(curl -s --max-time 2 "$STATUS" | node "$(dirname "$0")/pick-session.mjs" "$URL")
  [ -n "$SESSION" ] && break
  sleep 1
done
[ -n "$SESSION" ] || die "no session connected at $URL after 60s. The SDK is not loading in the page: check the plugin is in the build config, the dev server was restarted after init, and the connect is not guarded on hostname==='localhost'. curl https://docs.reticle.sh/troubleshooting.md"
say "connected: $SESSION"
mark "session"

# --- phase 5: the verdict, in a process that HAS the tools -------------------------------------
# This is the restart bottleneck, deleted. The calling session's MCP list was read at ITS startup
# and cannot be reloaded; a child `claude -p` reads the list init just wrote, so it can drive.
if (( DRIVE )) && command -v claude >/dev/null; then
  say "driving one flow in a fresh claude process (it has the reticle_* tools; this session does not yet)"
  claude -p --allowedTools "mcp__reticle" --permission-mode acceptEdits \
    "Reticle is installed and session $SESSION is connected at $URL. Drive the single most important user flow in as few calls as possible: reticle_snapshot({mode:'interactive'}) once, reticle_act_sequence for the setup steps, then ONE reticle_act_and_wait({ref,action,until}) for the verdict, then reticle_state(). Wrap it in reticle_record start/stop and reticle_flow_save. Report the flow name, the verdict, and assertions.grade in three lines." \
    2>&1 | tee "$LOG_DIR/onboard-drive.log"
  mark "drive"
else
  say "AGENT: no claude binary (or --no-drive) — step 5 is yours: snapshot, act_sequence, ONE act_and_wait, state."
fi

# --- optional: relaunch this session so IT gets the tools too ----------------------------------
# Claude reads its MCP list once, at startup, so a switch is a RESTART. Nothing inside the process
# can do it; only whatever launched it and is still waiting. CL_RUN means a supervisor is waiting
# (write account<TAB>session, SIGTERM, it relaunches with --resume). Otherwise open a new window.
if (( RELAUNCH )) && [ -n "${CLAUDE_CODE_SESSION_ID:-}" ] && [ -n "${CLAUDE_PID:-}" ]; then
  if [ -n "${CL_RUN:-}" ]; then
    d="${CL_HANDOFF_DIR:-$HOME/.claude-shared/cl-handoff}"; mkdir -p "$d"
    printf '%s\t%s\n' "$(basename "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" | sed 's/^\.claude-*//')" "$CLAUDE_CODE_SESSION_ID" > "$d/$CL_RUN"
    say "handing off: this conversation restarts with the reticle tools loaded."
    ( sleep 1; kill -TERM "$CLAUDE_PID" ) >/dev/null 2>&1 &
  elif [ "${TERM_PROGRAM:-}" = "Apple_Terminal" ] || [ "${TERM_PROGRAM:-}" = "iTerm.app" ]; then
    app=Terminal; [ "$TERM_PROGRAM" = "iTerm.app" ] && app=iTerm
    osascript -e "tell application \"$app\" to do script \"cd $PWD && claude --resume $CLAUDE_CODE_SESSION_ID\"" >/dev/null
    say "reopened this conversation in a new $app window with the tools loaded; this one can be closed."
  else
    say "AGENT: tell the user to restart their client once; the tools load at startup."
  fi
fi

say ""
say "TIMING:"; printf "%b" "$PHASE_LOG"
say "  total: $(( $(date +%s) - T0 ))s"
