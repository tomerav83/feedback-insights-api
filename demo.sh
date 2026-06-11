#!/usr/bin/env bash
#
# demo.sh — narrated end-to-end walkthrough of the feedback-insights API.
#
# Drives the full RECEIVED -> ANALYZING -> DONE/FAILED pipeline with plain curl:
# submit feedback, poll for the async analysis, show dedupe, show a FAILED row +
# retry, and exercise the read/list API. Written as a single clean take so it can
# be screen-recorded straight through.
#
# It runs against the default deterministic FAKE LLM (no API key, no network),
# which is exactly what makes the demo reproducible: the same content always
# yields the same analysis.
#
# PREREQUISITE: start the server in another terminal first, against the FAKE LLM:
#     LLM_BASE_URL= npm start
# (An empty LLM_BASE_URL forces the offline fake even if your .env points at a live
# backend. The fake is what makes this demo deterministic — step 5 in particular uses
# its __FAIL_SCHEMA__ failure-injection sentinel, which a real compliant model won't
# reproduce. To demo a live model instead, run plain `npm start` with a configured
# .env; steps 1-4 and 6 still work, but step 5 may return a valid analysis.)
# Optionally install `jq` for pretty-printed JSON (the script falls back to raw
# output if jq is absent). Override the target with BASE=http://host:port ./demo.sh
#
# PACING (so the output is readable on screen / in a recording):
#   - Default: the script PAUSES after each step and waits for you to press Enter,
#     so you control the pace of the recording.
#   - Unattended take: set STEP_DELAY=<seconds> to auto-advance instead of waiting,
#     e.g.  STEP_DELAY=4 ./demo.sh   (no terminal? it also falls back to STEP_DELAY).
#
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
STEP_DELAY="${STEP_DELAY:-}"

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

echo
echo "== 1. Health check =="
echo "# Confirms the server is up and which LLM backend is wired."
echo "# Expect llm:'fake' — the deterministic offline backend (no key, no network)."
curl -s "$BASE/health" | show
pause

echo "== 2. Submit POSITIVE feedback (with a feature request) =="
echo "# Async ingest: POST returns 202 RECEIVED immediately, analysis runs in the background."
RESP_A=$(post "I love how fast this app is! Please add a dark mode and CSV export.")
ID_A=$(printf '%s' "$RESP_A" | extract_id)
echo "# Captured id A = $ID_A"
echo "# Polling until the worker finishes the analysis..."
poll "$ID_A"
echo "# Note: positive sentiment, a feature_requests entry, and an actionable_insight."
pause

echo "== 3. Submit NEGATIVE feedback =="
echo "# Same pipeline; the fake LLM's keyword heuristics score this one negative."
RESP_B=$(post "The app keeps crashing and it's incredibly slow. Worst update ever.")
ID_B=$(printf '%s' "$RESP_B" | extract_id)
echo "# Captured id B = $ID_B"
poll "$ID_B"
echo "# Note: negative sentiment."
pause

echo "== 4. Dedupe guardrail =="
echo "# Re-POST the EXACT same content as step 2. The API dedupes by content hash:"
echo "# it returns 200 with deduplicated:true and the SAME id A — no duplicate row,"
echo "# no new analysis, no wasted LLM spend."
RESP_DUP=$(post "I love how fast this app is! Please add a dark mode and CSV export.")
ID_DUP=$(printf '%s' "$RESP_DUP" | extract_id)
echo "# Returned id = $ID_DUP (should equal id A = $ID_A)"
pause

echo "== 5. FAILED analysis + retry =="
echo "# The __FAIL_SCHEMA__ sentinel makes the fake LLM return JSON of the wrong shape,"
echo "# so the worker rejects it and the row ends up FAILED — with the raw response and"
echo "# error persisted for debugging."
RESP_C=$(post "Please process this __FAIL_SCHEMA__ feedback")
ID_C=$(printf '%s' "$RESP_C" | extract_id)
echo "# Captured id C = $ID_C"
poll "$ID_C" || true
echo "# Note: status FAILED, valid:false, error set, rawResponse captures the bad output."
pause
echo "# Now retry it: POST /feedback/:id/retry flips FAILED -> RECEIVED and re-enqueues (202)."
curl -s -X POST "$BASE/feedback/$ID_C/retry" | show
echo "# Poll again. It fails the same way (deterministic), but this is attempt 2 —"
echo "# the previous attempt's history is preserved, proving retry works end-to-end."
poll "$ID_C" || true
pause

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

echo "== 7. Done =="
echo "# That entire flow ran offline against the deterministic fake LLM — no API key,"
echo "# no network — which is what makes this demo reproducible."
echo "# Setting LLM_BASE_URL switches to a real OpenAI-compatible model with no code"
echo "# changes: the same pipeline, routes, and guardrails run unchanged."
echo
