#!/usr/bin/env bash
# Starts mock provider (:4002) + router (:3002) on a fresh SQLite file and walks the graded scenarios.
set -euo pipefail
cd "$(dirname "$0")"
[ -d dist ] || npm run build >/dev/null
mkdir -p data; rm -f data/demo.db data/demo.db-wal data/demo.db-shm
LOGDIR=$(mktemp -d)
node dist/mock-provider/server.js 2>"$LOGDIR/mock.log" & M=$!
DB_PATH=./data/demo.db node dist/server.js 2>"$LOGDIR/router.log" & R=$!
trap 'kill $M $R 2>/dev/null || true' EXIT
for i in $(seq 1 50); do curl -sf localhost:3002/readyz >/dev/null 2>&1 && break; sleep 0.1; done

mode() { curl -s localhost:4002/__control -d "$1" >/dev/null; }
call() { curl -s -w ' | HTTP %{http_code} in %{time_total}s\n' localhost:3002/v1/complete -H "x-api-key: $1" -H 'content-type: application/json' -d "$2"; }

echo "== 1) normal: primary answers =="
call tenantA '{"prompt":"hello","max_tokens":50}'
echo; echo "== 2) 20 concurrent requests estimating 5,000 tokens each -> exactly 10 accepted =="
PIDS=()
for i in $(seq 1 20); do
  curl -s -o /dev/null -w '%{http_code}\n' localhost:3002/v1/complete -H 'x-api-key: burst' -H 'content-type: application/json' \
    -d '{"prompt":"burst","max_tokens":4998,"estimated_tokens":5000}' >"$LOGDIR/burst.$i" & PIDS+=($!)
done
wait "${PIDS[@]}"
cat "$LOGDIR"/burst.* | sort | uniq -c | awk '{print "HTTP " $2 " x" $1}'

echo; echo "== 3) primary 429 -> secondary immediately =="
mode '{"primary":"429"}'; call tenantA '{"prompt":"hello","max_tokens":50}'
echo; echo "== 4) primary timeout -> secondary in just over 3 s =="
mode '{"primary":"timeout"}'; call tenantA '{"prompt":"hello","max_tokens":50}'
echo; echo "== 5) both fail (500 then 429) -> 503 with the sanitized payload =="
mode '{"primary":"500","secondary":"429"}'; call tenantA '{"prompt":"hello","max_tokens":50}'
mode '{"primary":"ok","secondary":"ok"}'
echo; echo "== 6) SQLite on disk =="
if command -v sqlite3 >/dev/null; then
  sqlite3 data/demo.db 'select tenant, count(*) as rows, sum(tokens) as tokens, group_concat(distinct provider) as providers from usage group by tenant'
else
  node --no-warnings -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("data/demo.db",{readOnly:true});console.table(db.prepare("select tenant, count(*) as rows, sum(tokens) as tokens, group_concat(distinct provider) as providers from usage group by tenant").all())'
fi
echo; echo "== router log for the 503 (private detail stays here, under the same request_id) =="
grep '"request.failed"' "$LOGDIR/router.log" | tail -1 | jq -c '{requestId, code, status, cause: (.cause.message // .cause)}'
