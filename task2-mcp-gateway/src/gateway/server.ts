// MCP security gateway: client --Bearer--> gateway --service token--> downstream.
// 1. authenticate (no token or unknown token: 401, never a default role)
// 2. authorize each JSON-RPC message (admin_* tools need role=admin, else -32001 without touching downstream)
// 3. forward everything else byte-for-byte and stream the response back (JSON or SSE)
// 4. Mcp-Session-Id passes through both ways; the client's Authorization header is dropped.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Agent, request as undiciRequest } from "undici";
import { extractBearer, resolveRole, tokensFromEnv } from "./auth.js";
import { decide, invalidRequestError, unauthorizedError, type Role } from "./policy.js";
import { log } from "../log.js";

const PORT = Number(process.env.GATEWAY_PORT ?? 3000);
const DOWNSTREAM_URL = process.env.DOWNSTREAM_URL ?? "http://localhost:4000/mcp";
const SERVICE_TOKEN = process.env.DOWNSTREAM_SERVICE_TOKEN ?? "svc-local-dev";
const MAX_BODY = 1_000_000;
const tokens = tokensFromEnv();

// Hop-by-hop headers must not be proxied; Authorization is the client's secret and never leaves the gateway.
const DROP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length", "authorization"]);
const FORWARD_REQ = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
const FORWARD_RES = ["content-type", "mcp-session-id", "mcp-protocol-version", "cache-control"];
const agent = new Agent({ headersTimeout: 10_000, bodyTimeout: 0 }); // SSE streams may idle

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...extra });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function audit(fields: Record<string, unknown>): void {
  log("info", "gateway.decision", fields);
}

async function proxy(req: IncomingMessage, res: ServerResponse, body: Buffer | undefined, ctx: { role: Role; requestId: string; method?: string; tool?: string; t0: number }) {
  const headers: Record<string, string> = {};
  for (const h of FORWARD_REQ) {
    const v = req.headers[h];
    if (typeof v === "string") headers[h] = v;
  }
  for (const [k, v] of Object.entries(req.headers)) {
    if (!DROP.has(k) && typeof v === "string" && !(k in headers) && k.startsWith("x-")) headers[k] = v;
  }
  headers["x-forwarded-for"] = [req.headers["x-forwarded-for"], req.socket.remoteAddress].filter(Boolean).join(", ");
  headers["x-gateway-role"] = ctx.role;
  headers["x-request-id"] = ctx.requestId;
  headers["x-gateway-service-token"] = SERVICE_TOKEN;

  const ac = new AbortController();
  req.on("close", () => ac.abort());
  let upstream;
  try {
    upstream = await undiciRequest(DOWNSTREAM_URL, { method: req.method as "GET" | "POST" | "DELETE", headers, body: body?.length ? body : undefined, dispatcher: agent, signal: ac.signal });
  } catch (err) {
    log("error", "gateway.upstream_error", { requestId: ctx.requestId, error: err instanceof Error ? err.message : String(err) });
    if (!res.headersSent) sendJson(res, 502, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Downstream unavailable" } }, { "x-request-id": ctx.requestId });
    return;
  }
  const out: Record<string, string> = { "x-request-id": ctx.requestId };
  for (const h of FORWARD_RES) {
    const v = upstream.headers[h];
    if (typeof v === "string") out[h] = v;
  }
  res.writeHead(upstream.statusCode, out);
  if ((upstream.headers["content-type"] ?? "").toString().includes("text/event-stream")) res.flushHeaders();
  Readable.from(upstream.body).on("error", () => res.destroy()).pipe(res);
  res.on("finish", () => audit({ ...ctx, decision: "allow", status: upstream.statusCode, latencyMs: +(performance.now() - ctx.t0).toFixed(1) }));
}

const server = createServer(async (req, res) => {
  const t0 = performance.now();
  const requestId = (typeof req.headers["x-request-id"] === "string" && req.headers["x-request-id"]) || randomUUID();
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/healthz") return sendJson(res, 200, { ok: true });
  if (url.pathname === "/readyz") {
    try {
      const r = await undiciRequest(new URL("/healthz", DOWNSTREAM_URL).toString(), { dispatcher: agent, headersTimeout: 2000 });
      await r.body.text();
      return sendJson(res, r.statusCode === 200 ? 200 : 503, { ok: r.statusCode === 200 });
    } catch {
      return sendJson(res, 503, { ok: false, downstream: "unreachable" });
    }
  }
  if (url.pathname !== "/mcp") return sendJson(res, 404, { error: "not found" });

  // 1. authenticate, fail closed
  const token = extractBearer(req.headers.authorization);
  const role = resolveRole(token, tokens);
  if (!role) {
    const reason = token ? "invalid_token" : "missing_token";
    audit({ requestId, role: null, decision: `401:${reason}`, status: 401 });
    return sendJson(res, 401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized", data: { reason } } }, { "www-authenticate": 'Bearer realm="mcp-gateway"', "x-request-id": requestId });
  }

  // GET (server->client SSE stream) and DELETE (end session) carry no JSON-RPC body
  if (req.method === "GET" || req.method === "DELETE") return proxy(req, res, undefined, { role, requestId, method: req.method, t0 });
  if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" }, { allow: "GET, POST, DELETE" });

  // 2. parse
  const raw = await readBody(req);
  if (raw === null) {
    // The rest of the oversized body is still on the wire. Close the connection after replying so a
    // keep-alive client cannot have those bytes parsed as its next request (seen as ECONNRESET).
    res.once("finish", () => req.destroy());
    return sendJson(res, 413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Body too large" } }, { connection: "close" });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    audit({ requestId, role, decision: "400:parse_error", status: 400 });
    return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { "x-request-id": requestId });
  }

  // 3. authorize every message in the body (batches are checked per message)
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  if (messages.length === 0) return sendJson(res, 400, invalidRequestError(null, "empty batch"), { "x-request-id": requestId });
  const decisions = messages.map((m) => decide(role, m));
  const first = messages[0] as { method?: unknown; params?: { name?: unknown } } | null;
  const ctx = { role, requestId, t0, method: typeof first?.method === "string" ? first.method : undefined, tool: typeof first?.params?.name === "string" ? first.params.name : undefined };

  const invalid = decisions.find((d) => d.kind === "invalid");
  if (invalid && invalid.kind === "invalid") {
    audit({ ...ctx, decision: `400:${invalid.reason}`, status: 400 });
    return sendJson(res, 400, invalidRequestError(invalid.id, invalid.reason), { "x-request-id": requestId });
  }
  if (decisions.some((d) => d.kind === "deny")) {
    // Fail closed for the whole batch. A JSON-RPC error is a transport-level success, so HTTP 200.
    const errors = decisions.map((d, i) =>
      d.kind === "deny" ? unauthorizedError(d.id, d.tool, role, d.required) : invalidRequestError((messages[i] as { id?: unknown })?.id ?? null, "batch rejected: contains an unauthorized tool call"),
    );
    audit({ ...ctx, decision: "deny:-32001", status: 200, latencyMs: +(performance.now() - t0).toFixed(1) });
    return sendJson(res, 200, Array.isArray(parsed) ? errors : errors[0], { "x-request-id": requestId });
  }

  // 4. forward
  // Forward what was authorized, not what was received: re-serializing the parsed value means a body with
  // duplicate keys ({"name":"admin_x","name":"echo"}) reaches the downstream exactly as `decide()` saw it,
  // whatever that downstream's own duplicate-key rule is. (Trade-off: integers beyond 2^53 are not preserved.)
  await proxy(req, res, Buffer.from(JSON.stringify(parsed)), ctx);
});

server.listen(PORT, () => log("info", "gateway.listening", { port: PORT, downstream: DOWNSTREAM_URL }));
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
