// Regressions found in the production-readiness audit. These use a byte-capturing fake downstream, so they
// prove what the gateway puts on the wire instead of relying on the mock's own JSON parser.
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DS = 14100, GWP = 13100;
const GW = `http://localhost:${GWP}/mcp`;
const ACCEPT = "application/json, text/event-stream";
let capture: Server, gw: ChildProcess;
const bodies: string[] = [];

beforeAll(async () => {
  if (!existsSync(resolve(root, "dist/gateway/server.js"))) execSync("npm run build", { cwd: root, stdio: "inherit" });
  capture = createServer((req, res) => {
    if (req.url === "/healthz") return void res.end("ok");
    const c: Buffer[] = [];
    req.on("data", (d) => c.push(d));
    req.on("end", () => {
      bodies.push(Buffer.concat(c).toString());
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
    });
  });
  await new Promise<void>((r) => capture.listen(DS, r));
  gw = spawn(process.execPath, [resolve(root, "dist/gateway/server.js")], { env: { ...process.env, GATEWAY_PORT: String(GWP), DOWNSTREAM_URL: `http://localhost:${DS}/mcp` }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://localhost:${GWP}/readyz`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("gateway did not start");
});
afterAll(async () => { gw.kill("SIGTERM"); await new Promise<void>((r) => capture.close(() => r())); });

describe("audit regressions", () => {
  it("duplicate JSON keys: the downstream receives exactly one `name`, the one the policy evaluated", async () => {
    bodies.length = 0;
    const raw = '{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"admin_reset_key","name":"echo","arguments":{}}}';
    const res = await fetch(GW, { method: "POST", headers: { accept: ACCEPT, "content-type": "application/json", authorization: "Bearer tok_viewer" }, body: raw });
    await res.text();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].match(/"name"/g)).toHaveLength(1);
    expect(JSON.parse(bodies[0]).params.name).toBe("echo");
  });

  it("413 tells the client to close the connection, so unread body bytes cannot become the next request", async () => {
    const reply = await new Promise<string>((resolveReply, reject) => {
      const s = connect(GWP, "localhost");
      let data = "";
      s.on("data", (d) => (data += d));
      s.on("close", () => resolveReply(data));
      s.on("error", (e) => (data ? resolveReply(data) : reject(e)));
      s.write(`POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer tok_viewer\r\nContent-Type: application/json\r\nContent-Length: 5000000\r\nConnection: keep-alive\r\n\r\n`);
      s.write("x".repeat(1_200_000));
      setTimeout(() => s.destroy(), 3000).unref();
    });
    expect(reply).toMatch(/^HTTP\/1.1 413/);
    expect(reply.toLowerCase()).toContain("connection: close");
  });
});
