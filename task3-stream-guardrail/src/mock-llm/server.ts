/**
 * Mock LLM provider. POST /v1/stream {prompt, chunk?, delay_ms?, repeat?}
 * Streams an OpenAI-style SSE response (data: {"choices":[{"delta":{"content":...}}]})
 * containing an email, an SSN and a credit-card number, in small chunks so PII
 * is routinely split across chunk boundaries. No API key needed.
 */
import { createServer } from "node:http";
import { log } from "../log.js";

const PORT = Number(process.env.MOCK_LLM_PORT ?? 4001);
const DEFAULT_DELAY_MS = Number(process.env.MOCK_LLM_DELAY_MS ?? 20);
const DEFAULT_CHUNK = Number(process.env.MOCK_LLM_CHUNK ?? 4);

export const CANNED =
  "Sure — here is the customer summary you asked for. The account holder is Jane Doe and her email on file is " +
  "jane.doe@example.com (backup: j_doe+billing@mail.example.co.uk). Her SSN is 123-45-6789 and the card ending " +
  "on the account is 4111 1111 1111 1111, with a secondary card 5500-0000-0000-0004. Her order number 1234 5678 9012 3456 " +
  "is not a card and should stay visible. Contact support@example.org if anything looks wrong. Have a great day!";

async function readJson(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, service: "mock-llm" }));
    return;
  }
  if (req.method !== "POST" || url.pathname !== "/v1/stream") {
    res.writeHead(404).end();
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "bad json" }));
    return;
  }
  const chunkSize = Math.max(1, Number(body.chunk ?? url.searchParams.get("chunk") ?? DEFAULT_CHUNK));
  const delay = Math.max(0, Number(body.delay_ms ?? url.searchParams.get("delay_ms") ?? DEFAULT_DELAY_MS));
  const repeat = Math.max(1, Math.min(10_000, Number(body.repeat ?? url.searchParams.get("repeat") ?? 1)));
  const text = (typeof body.text === "string" ? body.text : CANNED + " ").repeat(repeat);

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.flushHeaders();
  log("info", "mock-llm.stream.start", { chars: text.length, chunkSize, delay, repeat });

  let aborted = false;
  res.on("close", () => {
    if (!res.writableFinished) aborted = true;
  });
  const t0 = performance.now();
  for (let i = 0; i < text.length && !aborted; i += chunkSize) {
    const piece = text.slice(i, i + chunkSize);
    const frame = `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`;
    if (!res.write(frame)) await new Promise((r) => res.once("drain", r));
    if (delay) await new Promise((r) => setTimeout(r, delay));
  }
  if (!aborted) {
    res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write("data: [DONE]\n\n");
  }
  res.end();
  log("info", "mock-llm.stream.end", { aborted, ms: +(performance.now() - t0).toFixed(1) });
});

server.listen(PORT, () => log("info", "mock-llm.listening", { port: PORT }));
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
