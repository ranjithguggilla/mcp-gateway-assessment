#!/usr/bin/env bash
# Starts mock LLM (:4001) + guardrail (:3001), then streams with curl -N.
set -euo pipefail
cd "$(dirname "$0")"
[ -d dist ] || npm run build >/dev/null
LOGDIR=$(mktemp -d)
node dist/mock-llm/server.js 2>"$LOGDIR/mock.log" & M=$!
node dist/server.js 2>"$LOGDIR/gw.log" & G=$!
trap 'kill $M $G 2>/dev/null || true' EXIT
for i in $(seq 1 50); do curl -sf localhost:3001/readyz >/dev/null 2>&1 && break; sleep 0.1; done

echo "== raw provider output (what the LLM actually said) =="
curl -sN localhost:4001/v1/stream -H 'content-type: application/json' -d '{"prompt":"x","delay_ms":0}' \
  | sed -n 's/^data: //p' | grep -v '^\[DONE\]' | jq -rj '.choices[0].delta.content // empty'; echo; echo

echo "== through the guardrail, SSE frames arriving over time (curl -N) =="
curl -sN localhost:3001/v1/generate -H 'content-type: application/json' -d '{"prompt":"customer summary"}' | head -c 600 || true; echo "..."; echo

echo "== through the guardrail as plain text =="
curl -sN localhost:3001/v1/generate -H 'accept: text/plain' -H 'content-type: application/json' -d '{"prompt":"customer summary"}'; echo; echo

echo "== 1-char provider chunks (every secret split many times) =="
curl -sN localhost:3001/v1/generate -H 'accept: text/plain' -H 'content-type: application/json' -d '{"prompt":"x","provider":{"chunk":1,"delay_ms":0}}'; echo; echo

echo "== gateway log: TTFT and buffer bounds per request =="
grep request.complete "$LOGDIR/gw.log" | jq -c '{ttft_ms, provider_ttfb_ms, total_ms, chars_out, peak_hold_chars, peak_buffer_chars, redacted, heap_used_mb}'
