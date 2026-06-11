#!/usr/bin/env bash
#
# demo.sh — narrated end-to-end walkthrough of the feedback-insights API.
#
# Drives the full RECEIVED -> ANALYZING -> DONE/FAILED pipeline with plain curl:
# submit feedback, poll for the async analysis, show dedupe, show a FAILED row +
# retry, and exercise the read/list API. Written as a single clean take so it can
# be screen-recorded straight through.
#
# It works against EITHER backend and reports which one is live (it reads /health at
# the start and narrates accordingly):
#   - FAKE LLM (deterministic, offline, no key): run `LLM_BASE_URL= npm start`.
#       Fully reproducible, and step 5's FAILED demo works because the fake honours the
#       __FAIL_SCHEMA__ failure-injection sentinel.
#   - LIVE model (e.g. Groq/Ollama via your .env): run plain `npm start`.
#       Real model output. Note: a real model won't honour __FAIL_SCHEMA__, so step 5
#       won't deterministically produce a FAILED row — the script detects this and
#       adjusts its narration (use the fake if you want to demo the failure path).
#
# PREREQUISITE: start the server in another terminal first (one of the two above).
# Optionally install `jq` for pretty-printed JSON (the script falls back to raw
# output if jq is absent). Override the target with BASE=http://host:port ./demo.sh
#
# PACING (so the output is readable on screen / in a recording):
#   - Default: the script PAUSES after each step and waits for you to press Enter,
#     so you control the pace of the recording.
#   - Unattended take: set STEP_DELAY=<seconds> to auto-advance instead of waiting,
#     e.g.  STEP_DELAY=4 ./demo.sh   (no terminal? it also falls back to STEP_DELAY).
#
# STEP SELECTION: set STEPS to a comma-separated subset to run only those steps,
#   e.g.  STEPS=1,5 ./demo.sh   (just health + the FAILED/retry path).
#   Steps: 1 health  2 positive  3 negative  4 dedupe  5 FAILED+retry  6 read-API  7 outro.
#   (The /health backend probe always runs so step narration stays accurate.)
#
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
STEP_DELAY="${STEP_DELAY:-}"
STEPS="${STEPS:-1,2,3,4,5,6,7}"

# True if step N is in the selected STEPS set.
want() { case ",$STEPS," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

# --- helpers ----------------------------------------------------------------

# Pretty-print a JSON blob with jq if available, else echo it raw.
if command -v jq >/dev/null 2>&1; then
  HAVE_JQ=1
else
  HAVE_JQ=0
  echo "(jq not found — printing raw JSON. Install jq for pretty output.)" >&2
fi

show() {
  if [ "$HAVE_JQ" -eq 1 ]; then
    jq .
  else
    cat
  fi
}

# Extract the "id" field from a JSON response on stdin (jq, or grep/sed fallback).
extract_id() {
  if [ "$HAVE_JQ" -eq 1 ]; then
    jq -r '.id'
  else
    grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/'
  fi
}

# Extract the "status" field from a JSON response on stdin.
extract_status() {
  if [ "$HAVE_JQ" -eq 1 ]; then
    jq -r '.status'
  else
    grep -o '"status"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed 's/.*"status"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/'
  fi
}

# Extract the "llm" field (live|fake) from the /health JSON on stdin.
extract_llm() {
  if [ "$HAVE_JQ" -eq 1 ]; then
    jq -r '.llm'
  else
    grep -o '"llm"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed 's/.*"llm"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/'
  fi
}

# POST content to /feedback, pretty-print the response, and echo it raw on stdout
# (so a caller can capture the id). Body goes to stdout; narration to stderr.
post() {
  local content="$1"
  local body
  body=$(curl -s -X POST "$BASE/feedback" \
    -H 'Content-Type: application/json' \
    -d "{\"content\": $(json_string "$content")}")
  printf '%s' "$body" | show >&2
  printf '%s' "$body"
}

# JSON-encode a string (with jq if present; otherwise a minimal escaper good
# enough for the plain ASCII content this demo uses).
json_string() {
  if [ "$HAVE_JQ" -eq 1 ]; then
    printf '%s' "$1" | jq -Rs .
  else
    local s="$1"
    s=${s//\\/\\\\}
    s=${s//\"/\\\"}
    printf '"%s"' "$s"
  fi
}

# Poll GET /feedback/:id every ~0.4s until status is DONE or FAILED (cap 15
# tries), then pretty-print the final feedback + analysis.
poll() {
  local id="$1"
  local i status body
  for i in $(seq 1 15); do
    body=$(curl -s "$BASE/feedback/$id")
    status=$(printf '%s' "$body" | extract_status)
    if [ "$status" = "DONE" ] || [ "$status" = "FAILED" ]; then
      echo "   -> reached terminal status: $status (after $i poll(s))"
      printf '%s' "$body" | show
      return 0
    fi
    sleep 0.4
  done
  echo "   -> gave up after 15 polls; last status: ${status:-<none>}" >&2
  printf '%s' "$body" | show
  return 1
}

# Pause between steps so the output stays readable. Waits for Enter by default (you
# drive the pace); if STEP_DELAY is set, or there's no interactive terminal, it sleeps
# that many seconds instead of blocking.
pause() {
  echo
  if [ -n "$STEP_DELAY" ]; then
    sleep "$STEP_DELAY"
  elif [ -r /dev/tty ]; then
    printf '   --- press Enter to continue --- ' > /dev/tty
    read -r _ < /dev/tty || true
    echo
  else
    sleep 3
  fi
  echo
}

# --- flow -------------------------------------------------------------------

# id captures, pre-initialised so any STEPS subset is safe under `set -u`.
RESP_A=""; ID_A=""; RESP_B=""; ID_B=""; RESP_DUP=""; ID_DUP=""; RESP_C=""; ID_C=""; ST_C=""

# Always probe the backend (cheap) so each step narrates the right thing even when
# step 1 itself isn't selected.
HEALTH=$(curl -s "$BASE/health")
LLM_MODE=$(printf '%s' "$HEALTH" | extract_llm)
if [ "$LLM_MODE" = "fake" ]; then
  BACKEND_DESC="the deterministic fake LLM (keyword heuristics, offline)"
else
  BACKEND_DESC="the live model (llm='$LLM_MODE')"
fi

if want 1; then
  echo
  echo "== 1. Health check =="
  echo "# Confirms the server is up and which LLM backend is wired."
  printf '%s' "$HEALTH" | show
  if [ "$LLM_MODE" = "fake" ]; then
    echo "# Backend: llm='fake' — deterministic offline backend (no key, no network)."
  else
    echo "# Backend: llm='$LLM_MODE' — a real OpenAI-compatible model (e.g. Groq/Ollama)."
  fi
  pause
fi

if want 2; then
  echo "== 2. Submit POSITIVE feedback (with a feature request) =="
  echo "# Async ingest: POST returns 202 RECEIVED immediately, analysis runs in the background."
  RESP_A=$(post "I love how fast this app is! Please add a dark mode and CSV export.")
  ID_A=$(printf '%s' "$RESP_A" | extract_id)
  echo "# Captured id A = $ID_A"
  echo "# Polling until the worker finishes the analysis..."
  poll "$ID_A"
  echo "# Note: positive sentiment, a feature_requests entry, and an actionable_insight."
  pause
fi

if want 3; then
  echo "== 3. Submit NEGATIVE feedback =="
  echo "# Same pipeline; $BACKEND_DESC scores this one's sentiment (expected: negative)."
  RESP_B=$(post "The app keeps crashing and it's incredibly slow. Worst update ever.")
  ID_B=$(printf '%s' "$RESP_B" | extract_id)
  echo "# Captured id B = $ID_B"
  poll "$ID_B"
  echo "# Note: negative sentiment."
  pause
fi

if want 4; then
  echo "== 4. Dedupe guardrail =="
  echo "# Re-POST the EXACT same content as step 2. The API dedupes by content hash:"
  echo "# it returns 200 with deduplicated:true and the SAME id — no duplicate row,"
  echo "# no new analysis, no wasted LLM spend."
  RESP_DUP=$(post "I love how fast this app is! Please add a dark mode and CSV export.")
  ID_DUP=$(printf '%s' "$RESP_DUP" | extract_id)
  echo "# Returned id = $ID_DUP${ID_A:+ (should equal id A = $ID_A)}"
  pause
fi

if want 5; then
  echo "== 5. FAILED analysis + retry =="
  echo "# Exercises the defensive path: invalid model output -> FAILED (raw + error persisted),"
  echo "# then a manual retry."
  if [ "$LLM_MODE" = "fake" ]; then
    echo "# The fake LLM honours the __FAIL_SCHEMA__ sentinel: it returns JSON of the wrong shape,"
    echo "# so the worker's Zod re-validation rejects it and the row ends up FAILED."
  else
    echo "# NOTE: you're on a live model ($LLM_MODE), which won't honour the __FAIL_SCHEMA__ sentinel —"
    echo "# it just analyzes the text normally, so this will likely end up DONE, not FAILED. To demo"
    echo "# the deterministic FAILED + retry path, restart the server with:  LLM_BASE_URL= npm start"
  fi
  RESP_C=$(post "Please process this __FAIL_SCHEMA__ feedback")
  ID_C=$(printf '%s' "$RESP_C" | extract_id)
  echo "# Captured id C = $ID_C"
  poll "$ID_C" || true
  ST_C=$(curl -s "$BASE/feedback/$ID_C" | extract_status)
  pause
  if [ "$ST_C" = "FAILED" ]; then
    echo "# Item is FAILED (valid:false, error set, rawResponse kept). Now retry it:"
    echo "# POST /feedback/:id/retry flips FAILED -> RECEIVED and re-enqueues (202)."
    curl -s -X POST "$BASE/feedback/$ID_C/retry" | show
    echo "# Poll again -> a fresh attempt (attempt 2); the prior attempt's history is preserved,"
    echo "# proving retry works end-to-end."
    poll "$ID_C" || true
  else
    echo "# Item is $ST_C, not FAILED — the live model produced valid output, so there is nothing to"
    echo "# retry (retry only applies to FAILED items; calling it here would return 409). Run against"
    echo "# the fake LLM (LLM_BASE_URL= npm start) to see the FAILED + retry path deterministically."
  fi
  pause
fi

if want 6; then
  echo "== 6. Read API =="
  echo "# List ALL feedback with current status + latest analysis."
  curl -s "$BASE/feedback" | show
  pause
  echo "# Filter to completed analyses only: ?status=DONE"
  curl -s "$BASE/feedback?status=DONE" | show
  pause
  echo "# Filter to failed analyses only: ?status=FAILED"
  curl -s "$BASE/feedback?status=FAILED" | show
  pause
fi

want 7 || exit 0
echo "== 7. Done =="
if [ "$LLM_MODE" = "fake" ]; then
  echo "# That entire flow ran offline against the deterministic fake LLM — no API key, no"
  echo "# network — which is what makes this demo reproducible. Setting LLM_BASE_URL switches to"
  echo "# a real OpenAI-compatible model (Groq/Ollama) with no code changes: same pipeline,"
  echo "# routes, and guardrails."
else
  echo "# That flow ran against a live model (llm='$LLM_MODE') — the same pipeline, routes, and"
  echo "# guardrails. Unset LLM_BASE_URL (LLM_BASE_URL= npm start) to run fully offline against the"
  echo "# deterministic fake, which also makes the step-5 FAILED + retry path reproducible."
fi
echo
