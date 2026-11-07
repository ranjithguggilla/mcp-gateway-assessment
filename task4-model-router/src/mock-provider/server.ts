/**
 * Mock model providers with failure switches.
 *   POST /primary, POST /secondary   {prompt, max_tokens} -> {text, usage}
 *   GET/POST /__control              {"primary":"ok|429|timeout|500","secondary":"ok|429|timeout|500","usage":"max|actual"}
 * Initial modes from env MOCK_PRIMARY_MODE / MOCK_SECONDARY_MODE (default ok).
 * "timeout" mode sleeps MOCK_TIMEOUT_DELAY_MS (default 5000) before answering —
 * longer than the gateway's 3000 ms deadline.
 */
import { createServer, type IncomingMessage } from "node:http";
import { log } from "../log.js";

type Mode = "ok" | "429" | "timeout" | "500";
const MODES: ReadonlySet<string> = new Set(["ok", "429", "timeout", "500"]);
const PORT = Number(process.env.MOCK_PROVIDER_PORT ?? 4002);
const TIMEOUT_DELAY_MS = Number(process.env.MOCK_TIMEOUT_DELAY_MS ?? 5000);
const LATENCY_MS = Number(process.env.MOCK_LATENCY_MS ?? 100);

const state: Record<"primary" | "secondary", Mode> = {
  primary: (MODES.has(process.env.MOCK_PRIMARY_MODE ?? "") ? process.env.MOCK_PRIMARY_MODE : "ok") as Mode,
  secondary: (MODES.has(process.env.MOCK_SECONDARY_MODE ?? "") ? process.env.MOCK_SECONDARY_MODE : "ok") as Mode,
};
const calls: Record<"primary" | "secondary", number> = { primary: 0, secondary: 0 };
// usage reporting. "max" (default): the model used its whole max_tokens budget, so a reservation
// reconciles to itself and a concurrent burst is deterministic. "actual": tokens really produced
// (tiny), which shows reconciliation freeing budget. Switch at runtime via /__control {"usage": ...}.
let usageMode: "actual" | "max" = process.env.MOCK_USAGE_MODE === "actual" ? "actual" : "max";

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

  if (url.pathname === "/healthz") return json(200, { ok: true, service: "mock-provider", modes: state, calls });
  if (url.pathname === "/__control") {
    if (req.method === "POST") {
      const b = await readJson(req);
      for (const k of ["primary", "secondary"] as const) {
        if (typeof b[k] === "string" && MODES.has(b[k] as string)) state[k] = b[k] as Mode;
      }
      if (b.reset_calls) { calls.primary = 0; calls.secondary = 0; }
      if (b.usage === "actual" || b.usage === "max") usageMode = b.usage;
      log("info", "mock.control", { modes: state });
    }
    return json(200, { modes: state, calls, usage: usageMode });
  }

  const which = url.pathname === "/primary" ? "primary" : url.pathname === "/secondary" ? "secondary" : null;
  if (!which || req.method !== "POST") return json(404, { error: "not found" });
  calls[which]++;
  const body: Record<string, unknown> = await readJson(req).catch(() => ({}));
  const mode = state[which];
  log("info", "mock.request", { provider: which, mode });

  if (mode === "429") return json(429, { error: { message: "Rate limit reached for model", type: "tokens" }, upstream_secret: "THIS MUST NEVER REACH THE CLIENT" });
  if (mode === "500") return json(500, { error: "Internal Server Error at mock-provider-host-01.internal", stack: "Error: boom\n    at handler (/srv/mock/server.js:42:11)" });
  if (mode === "timeout") {
    await new Promise((r) => setTimeout(r, TIMEOUT_DELAY_MS));
    if (res.destroyed) return; // the gateway gave up
  } else if (LATENCY_MS) {
    await new Promise((r) => setTimeout(r, LATENCY_MS));
  }
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const text = `[${which}] ${prompt.slice(0, 40)} -> lorem ipsum dolor sit amet, consectetur adipiscing elit.`;
  const prompt_tokens = Math.ceil(prompt.length / 4);
  const completion_tokens = usageMode === "max" && typeof body.max_tokens === "number" ? body.max_tokens : Math.ceil(text.length / 4);
  return json(200, { text, usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens }, model: `${which}-mock-v1` });
});

server.listen(PORT, () => log("info", "mock-provider.listening", { port: PORT, modes: state }));
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
