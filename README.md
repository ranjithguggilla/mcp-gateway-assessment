# MCP & LLM Gateway Assessment

Four runnable tasks in one repo, no external API keys needed. TypeScript on Node 22 with `@modelcontextprotocol/sdk` 1.x, `zod` 3, and the built-in `node:http`, `node:sqlite` and `fetch`. Every test suite spawns the **real process** and talks to it over stdio or HTTP; nothing is mocked at the handler level.

| Task | Folder | What it proves | Tests |
|---|---|---|---|
| 1 — MCP server (stdio) | `task1-mcp-server/` | stdout is pure JSON-RPC, `-32602` on malformed input, `isError` on business failures | 18 |
| 2 — MCP security gateway | `task2-mcp-gateway/` | bearer → role, fail-closed 401, `-32001` for `admin_*` without touching the downstream | 24 |
| 3 — Streaming PII guardrail | `task3-stream-guardrail/` | redaction across chunk boundaries, bounded memory, measured TTFT | 29 |
| 4 — Rate limiter + fallback router | `task4-model-router/` | atomic SQLite reservation (20 → exactly 10), 429/timeout failover, sanitized 503 | 26 |

## Run everything

~~~bash
# Node >= 22.13 (node:sqlite), npm 10. jq and curl for the demo scripts.
npm ci
npm run build
npm test                    # all four suites, ~20 s (the 3 s and 6 s failover timeouts are real)

docker compose up --build   # gateway :3000, guardrail :3001, router :3002
~~~

Per task: `cd taskN-* && npm test`, and `npm run demo` for a scripted walkthrough that prints what each requirement looks like on the wire. All services log one JSON line per event to **stderr** only.

---

## Task 1 — MCP server with strict validation (stdio)

Every byte on stdout is a JSON-RPC 2.0 frame. Malformed arguments are rejected with `-32602` *before* the handler runs. Business failures (unknown customer, suspended account) are tool results with `isError: true`.

~~~bash
cd task1-mcp-server
node dist/server.js < fixtures/session.jsonl 2>/dev/null | jq -c '{id, error: .error.code, isError: .result.isError}'
node dist/server.js < fixtures/session.jsonl 2>/tmp/t1.err >/dev/null; head -3 /tmp/t1.err   # stderr: JSON logs only
npx @modelcontextprotocol/inspector node dist/server.js                                     # interactive client
~~~

Expected: ids 1–4 succeed, ids 10–19 are `-32602`, ids 20–21 are `isError: true`, id 22 (unknown tool) is `-32602`, id 23 (unknown method) is `-32601`. The fixture covers `CUST-1234`, `cust-12345`, `CUST-123456`, `xCUST-12345y`, a missing id, amount `-1`, amount `"10"`, amount `1e400` (Infinity), reason `"short"` and a whitespace-only reason.

Notes:

* I use the low-level `Server` rather than `McpServer.registerTool`. In SDK 1.x `McpServer` catches zod failures inside the handler and returns them as `isError: true`; the brief asks for a protocol error on bad params, so the `tools/call` handler is mine: `safeParse` → `McpError(InvalidParams, …, { issues })`. `tools/list` publishes the same zod schemas via `zod-to-json-schema`, so the model sees `pattern`, `exclusiveMinimum` and `minLength`.
* Schemas are anchored (`^CUST-\d{5}$`), `amount` is `number().finite().positive()` (no coercion, so `"10"` fails), `reason` is trimmed before `min(10)`, objects are `.strict()`.
* `src/harden.ts` is the first import and reroutes `console.*` to stderr before the SDK loads. A non-JSON line on stdin does not kill the server (tested).

## Task 2 — MCP security gateway

`Authorization: Bearer <token>` resolves to `admin` or `viewer`; anything else is HTTP 401 — there is no default role. `tools/call` on an `admin_*` tool by a non-admin is answered by the gateway itself with JSON-RPC `-32001 Unauthorized Tool Call`; the downstream log proves the call never arrived. Everything else is proxied as-is (JSON or SSE), `Mcp-Session-Id` passes both ways, the client's token is stripped and a separate service token identifies the gateway to the downstream.

~~~bash
cd task2-mcp-gateway && npm run demo
~~~

~~~
1) viewer tools/list        -> {"id":1,"result":{"tools":["echo","get_time","admin_reset_key"]}}
2) viewer echo              -> {"id":2,"result":{"content":[{"type":"text","text":"hi from viewer"}]}}
3) viewer admin_reset_key   -> {"id":3,"error":{"code":-32001,"message":"Unauthorized Tool Call","data":{"tool":"admin_reset_key","role":"viewer","required":"admin"}}}
4) admin  admin_reset_key   -> {"id":4,"result":{"content":[{"type":"text","text":"key rotated to v2"}]}}
5) no token  -> HTTP 401     6) bad token -> HTTP 401
admin_reset_key count in downstream log: 1     leaked client tokens seen by downstream: 0
~~~

Notes:

* `policy.ts` is a pure `decide(role, message) → allow | deny | invalid`, unit-tested on its own; the proxy only maps decisions to HTTP.
* Batches are checked per message; if any message is blocked the whole batch is refused (`-32001` for the blocked ids, `-32600` for the siblings). Notifications are forwarded.
* Hop-by-hop headers, `Host` and `Authorization` are dropped; `Accept`, `Content-Type`, `Mcp-Session-Id`, `Mcp-Protocol-Version`, `Last-Event-Id` are forwarded; `X-Request-Id`, `X-Gateway-Role` and the service token are added. GET (SSE) and DELETE (session end) go through the same auth.
* One stderr audit line per decision: `{requestId, role, method, tool, decision, status, latencyMs}`.
* The test suite also drives the official SDK `Client` + `StreamableHTTPClientTransport` through the gateway and asserts `callTool("admin_reset_key")` rejects with `code: -32001`.

## Task 3 — Streaming PII redaction guardrail

`POST /v1/generate` streams the provider's text back with emails, SSNs and card numbers replaced by `[REDACTED]`, including when a pattern is split across any number of chunks. Memory is bounded by the hold-back (≤ 254 chars plus one partial SSE frame), not by response length. The first token leaves before the stream ends and TTFT is logged per request.

~~~bash
cd task3-stream-guardrail && npm run demo
curl -N localhost:3001/v1/generate -H 'content-type: application/json' -d '{"prompt":"customer summary"}'
curl -N localhost:3001/v1/generate -H 'accept: text/plain' -H 'content-type: application/json' -d '{"prompt":"x"}'
~~~

The mock provider (`:4001`) streams a canned paragraph with three emails, an SSN, two Luhn-valid cards and one Luhn-invalid "order number" as OpenAI-style SSE, 4 characters per chunk at 20 ms, so every secret is split several times.

~~~
... her email on file is [REDACTED] (backup: [REDACTED]). Her SSN is [REDACTED] and the card ending on the
account is [REDACTED], with a secondary card [REDACTED]. Her order number 1234 5678 9012 3456 is not a card
and should stay visible. Contact [REDACTED] if anything looks wrong.
{"msg":"request.complete","ttft_ms":23.9,"provider_ttfb_ms":3,"total_ms":2342.1,"peak_hold_chars":31,"redacted":{"emails":3,"ssns":1,"cards":2,"cardsSkippedLuhn":1,"overflowSuppressed":0}}
~~~

Notes:

* `Redactor.push(chunk)` releases text up to the last *safe boundary*: a whitespace char not preceded by a digit. No supported pattern spans such a boundary (spaced card groups are kept together by the digit rule), so a match can never straddle a cut. The tail is force-cut at `MAX_HOLD = 254` (longest pattern: an RFC 5321 email); a forced slice that could hold a secret fragment (`@`, 13+ digits, a digit at the cut edge) is suppressed rather than released — fail closed, counted as `overflowSuppressed`.
* `SseParser` reassembles SSE events split across TCP reads; text is extracted from the provider frame before any regex runs. Luhn check on cards; SSN rejects area 000/666/9xx, group 00, serial 0000.
* `res.write`'s return value is honoured for backpressure; client disconnect aborts the provider fetch (tested: the mock logs `aborted: true`).
* Tests split the email, SSN and card at *every* index, check byte-identical passthrough of PII-free text, and stream ~4 MB through a gateway started with `--max-old-space-size=48`.

## Task 4 — Rate limiting and model fallback router

50,000 tokens per 60 s sliding window per `X-API-Key`, state in an on-disk SQLite file, reservation atomic under concurrency (`BEGIN IMMEDIATE`). The primary gets a hard 3,000 ms deadline; 429, timeout or 5xx fail over to the secondary once; 400 does not. Double failure → `503` with the one fixed error shape and a request id. Stack traces, hostnames and upstream bodies only ever reach stderr.

~~~bash
cd task4-model-router && npm run demo
~~~

~~~
== 2) 20 concurrent requests estimating 5,000 tokens each ==   HTTP 200 x10   HTTP 429 x10
== 3) primary 429 -> secondary ==      {"provider":"secondary","failed_over":true,...} | HTTP 200 in 0.103s
== 4) primary timeout -> secondary ==  {"provider":"secondary","failed_over":true,...} | HTTP 200 in 3.110s
== 5) both fail -> 503 ==   {"error":{"code":"UPSTREAM_UNAVAILABLE","message":"Model providers unavailable","request_id":"7cee…","retry_after_ms":1000}}
== 6) SQLite on disk ==     burst|10|50000|primary
~~~

API: `POST /v1/complete` with `X-API-Key: <tenant>` and `{"prompt", "max_tokens"?, "estimated_tokens"?}` → `{text, provider, failed_over, usage, request_id}`. Every response carries `X-Request-Id`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`; 429s add `Retry-After` and `retry_after_ms`. `GET /v1/usage` shows the current window. The mock provider (`:4002`) has runtime switches: `curl localhost:4002/__control -d '{"primary":"429|timeout|500|ok","secondary":"...","usage":"max|actual"}'`.

Notes:

* **Sliding log, not fixed window.** One `usage` table `(tenant, ts_ms, tokens, state)` with an index on `(tenant, ts_ms)`; used = `SUM(tokens) WHERE ts_ms > now - 60000`.
* **Reserve → reconcile.** Check and insert happen in one `BEGIN IMMEDIATE` transaction with `estimate = ceil(promptChars/4) + max_tokens` (or the client's `estimated_tokens`). On success the row is updated to the provider's `usage.total_tokens`; on failure it is deleted so failed calls do not burn quota. `retry_after_ms` is computed from when enough of the oldest rows age out, not a blanket 60 s.
* **A timeout that really closes the socket.** `AbortSignal.any([AbortSignal.timeout(3000), clientSignal])` is passed *into* `fetch`; `TimeoutError` is distinguished from a client `AbortError`. A primary answering at 3,001 ms is never recorded.
* **SQLite.** `node:sqlite` `DatabaseSync`, WAL, `busy_timeout=5000`. A sweeper deletes rows older than two windows; correctness never depends on it (tested with an injected clock and with two connections to the same file). Usage survives a router restart (tested).
* The mock's `usage: max` default reports the full `max_tokens` as spent, so the 20 → 10 burst is deterministic; `usage: actual` reports the ~25 tokens really produced and shows reconciliation freeing budget.

---

## Deployment shape (`docker-compose.yml`)

Mocks live on a compose network marked `internal: true`; only the three gateways also join `edge` and publish ports. Containers run read-only, non-root, `cap_drop: ALL`. The client's bearer token stops at the gateway; the gateway → downstream hop carries a separate service token. `/healthz` needs no auth, `/readyz` checks the dependency (downstream, provider, or that SQLite opens). Every log line is JSON on stderr with `X-Request-Id` propagated end to end and surfaced in error bodies, so a customer can quote it on a ticket.

## Spec versions

Built against the MCP wire line that `@modelcontextprotocol/sdk` 1.x implements (`initialize`, `Mcp-Session-Id`, Streamable HTTP) and that the task wording uses. `-32001` sits in the implementation-defined JSON-RPC range. Pins: Node 22 LTS (`node:sqlite` needs ≥ 22.13), `@modelcontextprotocol/sdk ^1`, `zod ^3`, `vitest 4.0.18`.

## Known limitations

* **Task 2 — auth is demo-grade.** A static token → role map (`STATIC_TOKENS`). The `resolveRole` contract (a role or `null`) is where JWT/JWKS verification would plug in; it is not implemented.
* **Task 2 — batches fail closed as a unit.** A batch with one blocked call is refused entirely rather than partially forwarded.
* **Task 3 — regex only.** Names, addresses, phone numbers and IBANs are not redacted; obfuscated emails (`jane at example dot com`) pass through. Long whitespace-free alphanumeric blobs with digits at a cut edge may be over-redacted; that is the safe direction for a privacy filter. Up to one word is held until the next whitespace, so the hold-back delays the *last* token, never the first.
* **Task 4 — single-node limiter.** One SQLite file is correct for one host (and across processes on that host) but is not a distributed limiter; N gateway instances would need Redis or Postgres. Token estimates are `chars/4`, not a real tokenizer. A crash between reserve and finalize leaves a `reserved` row at its estimate until it ages out of the window. One retry, no circuit breaker.
* **Docker.** `docker compose config` validates the file; I verified the tasks via the npm commands above, so treat the image build as the least-exercised path.
* `node:sqlite` prints an `ExperimentalWarning` on Node 22; it is stable in Node 24.

## What I would change for production

JWT with JWKS rotation and `iss`/`aud` checks, OpenTelemetry traces with `traceparent` end to end, NER-assisted PII detection with per-tenant redaction policy, a Redis-backed limiter with a real tokenizer and a per-provider circuit breaker, streaming completions through the router, and mTLS between gateway and downstream.
