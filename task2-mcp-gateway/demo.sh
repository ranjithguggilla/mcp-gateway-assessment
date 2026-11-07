#!/usr/bin/env bash
# Starts mock downstream (:4000) + gateway (:3000), runs the four graded calls, then shows the
# downstream log to prove the blocked call never arrived.
set -euo pipefail
cd "$(dirname "$0")"
[ -d dist ] || npm run build >/dev/null
GW=http://localhost:3000/mcp
LOGDIR=$(mktemp -d)
node dist/mock-downstream/server.js 2>"$LOGDIR/downstream.log" & DS=$!
node dist/gateway/server.js 2>"$LOGDIR/gateway.log" & GWP=$!
trap 'kill $DS $GWP 2>/dev/null || true' EXIT
for i in $(seq 1 50); do curl -sf localhost:3000/readyz >/dev/null 2>&1 && break; sleep 0.1; done

ACCEPT='Accept: application/json, text/event-stream'
CT='Content-Type: application/json'
init() {
  curl -s -D - -o /dev/null "$GW" -H "$ACCEPT" -H "$CT" -H "Authorization: Bearer $1" \
    -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"demo","version":"1"}}}' \
    | awk 'tolower($1)=="mcp-session-id:" {print $2}' | tr -d '\r'
}
call() {
  curl -s "$GW" -H "$ACCEPT" -H "$CT" -H "Authorization: Bearer $1" -H "Mcp-Session-Id: $2" -d "$3" \
    | sed -n 's/^data: //p; /^{/p' | head -1 | jq -c '{id, result: (.result|if .==null then null elif .tools then {tools: [.tools[].name]} else . end), error}'
}
VS=$(init tok_viewer); AS=$(init tok_admin)
echo "viewer session: $VS"; echo "admin  session: $AS"; echo
echo "1) viewer tools/list        -> expect the tool list"
call tok_viewer "$VS" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
echo "2) viewer echo              -> expect result"
call tok_viewer "$VS" '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hi from viewer"}}}'
echo "3) viewer admin_reset_key   -> expect -32001"
call tok_viewer "$VS" '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"admin_reset_key","arguments":{}}}'
echo "4) admin  admin_reset_key   -> expect result"
call tok_admin "$AS" '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"admin_reset_key","arguments":{}}}'
echo; echo "5) no token  -> $(curl -s -o /dev/null -w 'HTTP %{http_code}' "$GW" -H "$ACCEPT" -H "$CT" -d '{"jsonrpc":"2.0","id":5,"method":"tools/list"}')"
echo "6) bad token -> $(curl -s -o /dev/null -w 'HTTP %{http_code}' "$GW" -H "$ACCEPT" -H "$CT" -H "Authorization: Bearer nope" -d '{"jsonrpc":"2.0","id":6,"method":"tools/list"}')"
echo; echo "---- downstream tools/call log (admin_reset_key must appear exactly once, from the admin) ----"
grep 'downstream.tools/call' "$LOGDIR/downstream.log" | jq -c '{tool, sessionId}'
echo "admin_reset_key count: $(grep -c admin_reset_key "$LOGDIR/downstream.log")"
echo "leaked client tokens seen by downstream: $(grep -c leaked_client_authorization "$LOGDIR/downstream.log" || true)"
