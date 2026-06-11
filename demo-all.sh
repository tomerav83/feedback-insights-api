#!/usr/bin/env bash
#
# demo-all.sh — one-command, two-phase demo orchestrator.
#
# Runs the full walkthrough (./demo.sh) twice, each phase on its own throwaway DB
# and port, starting and stopping the server for you:
#
#   PHASE 1 — LIVE model: uses your .env (e.g. Groq) for REAL LLM analysis. Shows
#             the happy path end to end. (The __FAIL_SCHEMA__ step is a no-op on a
#             real model — demo.sh detects this and says so.)
#   PHASE 2 — FAKE LLM: forced offline + deterministic (LLM_BASE_URL=). This is the
#             phase that demonstrates the FAILED + retry defensive path reliably.
#
# Each phase: start server -> wait for /health -> run ./demo.sh -> stop server +
# delete the temp DB. A trap guarantees the server is killed even on Ctrl-C.
#
# PACING: demo.sh pauses for Enter between steps by default (you drive a recording).
#         Set STEP_DELAY=<seconds> to auto-advance, e.g.  STEP_DELAY=3 ./demo-all.sh
#
# Requires Node 22+ (the native better-sqlite3 build needs it); this script tries to
# select it via nvm if your current node is older.
#
set -euo pipefail

cd "$(dirname "$0")"   # repo root, so ./demo.sh and src/index.ts resolve

REAL_PORT="${REAL_PORT:-3201}"
FAKE_PORT="${FAKE_PORT:-3202}"

SERVER_PID=""
DB_FILE=""

# --- Node 22 selection (best effort) ----------------------------------------
node_major() { node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || echo 0; }
if [ "$(node_major)" -lt 22 ]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    nvm use >/dev/null 2>&1 || nvm install >/dev/null 2>&1 || true
  fi
fi
if [ "$(node_major)" -lt 22 ]; then
  echo "WARNING: Node 22+ recommended (found $(node -v 2>/dev/null || echo none)); better-sqlite3 may fail to load." >&2
fi

# Prefer the local tsx binary (one fewer process layer than npx, so kill is clean).
if [ -x "node_modules/.bin/tsx" ]; then
  TSX=(node_modules/.bin/tsx)
else
  TSX=(npx tsx)
fi

# --- lifecycle helpers ------------------------------------------------------
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  SERVER_PID=""
  if [ -n "$DB_FILE" ]; then
    rm -f "$DB_FILE" "$DB_FILE"-shm "$DB_FILE"-wal 2>/dev/null || true
  fi
  DB_FILE=""
}
trap cleanup EXIT INT TERM

wait_for_health() {
  local base="$1" i
  for i in $(seq 1 80); do
    curl -sf "$base/health" >/dev/null 2>&1 && return 0
    # bail early if the server process already died
    if [ -n "$SERVER_PID" ] && ! kill -0 "$SERVER_PID" 2>/dev/null; then
      return 1
    fi
    sleep 0.5
  done
  return 1
}

# run_phase <label> <port> <db> [extra env assignments for the server...]
run_phase() {
  local label="$1" port="$2" db="$3"; shift 3
  local base="http://localhost:$port"
  local logf="/tmp/demo-all-$port.log"

  echo
  echo "############################################################################"
  echo "#  $label"
  echo "#  $base   (db: $db)"
  echo "############################################################################"

  DB_FILE="$db"
  rm -f "$db" "$db"-shm "$db"-wal 2>/dev/null || true

  # Start the server. DB_PATH/PORT are set in the environment so dotenv won't override
  # them; any extra assignments (e.g. LLM_BASE_URL= to force the fake) come first.
  env "$@" DB_PATH="$db" PORT="$port" LOG_LEVEL=silent "${TSX[@]}" src/index.ts >"$logf" 2>&1 &
  SERVER_PID=$!

  if ! wait_for_health "$base"; then
    echo "ERROR: server did not become healthy at $base. Last log lines:" >&2
    tail -n 20 "$logf" >&2 || true
    cleanup
    return 1
  fi

  echo "# server up (pid $SERVER_PID) — /health: $(curl -s "$base/health")"
  echo

  # Run the walkthrough against this server. Don't let a demo non-zero exit abort
  # the orchestrator (we still want to clean up and run the next phase).
  BASE="$base" ./demo.sh || true

  cleanup
}

# --- run both phases --------------------------------------------------------
RC=0

# Phase 1: LIVE — inherit .env (Groq/Ollama). No extra env assignment.
run_phase "PHASE 1/2 — LIVE model (real LLM analysis; uses your .env)" \
  "$REAL_PORT" "/tmp/demo-live.db" || { echo "Phase 1 (live) failed — continuing to the fake phase." >&2; RC=1; }

# Phase 2: FAKE — force the deterministic offline backend for the FAILED + retry path.
run_phase "PHASE 2/2 — FAKE LLM (deterministic FAILED + retry path)" \
  "$FAKE_PORT" "/tmp/demo-fake.db" "LLM_BASE_URL=" || { echo "Phase 2 (fake) failed." >&2; RC=1; }

echo
echo "############################################################################"
echo "#  Both phases complete. Servers stopped, temp DBs removed."
echo "############################################################################"
exit "$RC"
