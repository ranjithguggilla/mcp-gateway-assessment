// Spawns the real mock downstream and the real gateway, drives them over HTTP, and reads the
// downstream's stderr to prove blocked calls never arrive.
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DS_PORT = 14000;
const GW_PORT = 13000;
const GW = `http://localhost:${GW_PORT}/mcp`;
const ACCEPT = "application/json, text/event-stream";

interface Proc { child: ChildProcess; stderr: () => string; stop: () => Promise<void> }
function start(script: string, env: Record<string, string>): Proc {
  const child = spawn(process.execPath, [resolve(root, script)], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr!.on("data", (d) => (err += d.toString()));
  return {
    child,
    stderr: () => err,
    stop: () => new Promise((res) => { if (child.exitCode !== null) return res(); child.once("exit", () => res()); child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 2000).unref(); }),
  };
}
async function waitFor(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timeout waiting for " + url);
}
async function rpcMessages(res: Response): Promise<any[]> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5).trim()));
  }
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}
async function rpc(token: string | null, sid: string | null, body: unknown) {
  const headers: Record<string, string> = { accept: ACCEPT, "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (sid) headers["mcp-session-id"] = sid;
  const res = await fetch(GW, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: res.status, headers: res.headers, msgs: await rpcMessages(res) };
}
async function initialize(token: string): Promise<string> {
  const r = await fetch(GW, {
    method: "POST",
    headers: { accept: ACCEPT, "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
  });
  const msgs = await rpcMessages(r);
  if (r.status !== 200 || !msgs[0]?.result) throw new Error(`initialize failed: ${r.status}`);
  const sid = r.headers.get("mcp-session-id");
  if (!sid) throw new Error("gateway did not pass Mcp-Session-Id back");
  await rpc(token, sid, { jsonrpc: "2.0", method: "notifications/initialized" });
  return sid;
}

let ds: Proc;
let gw: Proc;
const downstreamCalls = () => ds.stderr().split("\n").filter((l) => l.includes("downstream.tools/call")).map((l) => JSON.parse(l).tool as string);

beforeAll(async () => {
  if (!existsSync(resolve(root, "dist/gateway/server.js"))) execSync("npm run build", { cwd: root, stdio: "inherit" });
  ds = start("dist/mock-downstream/server.js", { DOWNSTREAM_PORT: String(DS_PORT) });
  gw = start("dist/gateway/server.js", { GATEWAY_PORT: String(GW_PORT), DOWNSTREAM_URL: `http://localhost:${DS_PORT}/mcp` });
  await waitFor(`http://localhost:${DS_PORT}/healthz`);
  await waitFor(`http://localhost:${GW_PORT}/readyz`);
});
afterAll(async () => { await Promise.all([gw?.stop(), ds?.stop()]); });

describe("the four graded calls", () => {
  let viewerSid: string;
  let adminSid: string;
  beforeAll(async () => {
    viewerSid = await initialize("tok_viewer");
    adminSid = await initialize("tok_admin");
  });

  it("session ids pass through from the downstream", () => {
    expect(viewerSid).toMatch(/^[0-9a-f-]{36}$/);
    expect(adminSid).not.toBe(viewerSid);
  });
  it("1. viewer tools/list is forwarded unchanged", async () => {
    const r = await rpc("tok_viewer", viewerSid, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(r.status).toBe(200);
    expect(r.msgs[0].result.tools.map((t: any) => t.name).sort()).toEqual(["admin_reset_key", "echo", "get_time"]);
  });
  it("2. viewer echo returns a result", async () => {
    const r = await rpc("tok_viewer", viewerSid, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { message: "hello" } } });
    expect(r.msgs[0].result.content[0].text).toBe("hello");
  });
  it("3. viewer admin_reset_key -> -32001 and the downstream is never contacted", async () => {
    const before = downstreamCalls().filter((t) => t === "admin_reset_key").length;
    const r = await rpc("tok_viewer", viewerSid, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "admin_reset_key", arguments: {} } });
    expect(r.status).toBe(200);
    expect(r.msgs[0]).toEqual({ jsonrpc: "2.0", id: 3, error: { code: -32001, message: "Unauthorized Tool Call", data: { tool: "admin_reset_key", role: "viewer", required: "admin" } } });
    await new Promise((r) => setTimeout(r, 100));
    expect(downstreamCalls().filter((t) => t === "admin_reset_key").length).toBe(before);
  });
  it("4. admin admin_reset_key succeeds and the downstream logs exactly that call", async () => {
    const before = downstreamCalls().filter((t) => t === "admin_reset_key").length;
    const r = await rpc("tok_admin", adminSid, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "admin_reset_key", arguments: {} } });
    expect(r.msgs[0].result.content[0].text).toMatch(/key rotated/);
    await new Promise((r) => setTimeout(r, 100));
    expect(downstreamCalls().filter((t) => t === "admin_reset_key").length).toBe(before + 1);
  });
  it("the client's bearer token never reaches the downstream", () => {
    expect(ds.stderr()).not.toContain("leaked_client_authorization");
  });
});

describe("fail-closed auth", () => {
  it.each([
    ["no header", {}],
    ["empty bearer", { authorization: "Bearer " }],
    ["basic scheme", { authorization: "Basic dXNlcjpwYXNz" }],
    ["unknown token", { authorization: "Bearer tok_unknown" }],
  ])("%s -> 401", async (_l, headers) => {
    const res = await fetch(GW, { method: "POST", headers: { accept: ACCEPT, "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe(-32001);
  });
});

describe("malformed bodies are never forwarded", () => {
  let sid: string;
  beforeAll(async () => (sid = await initialize("tok_admin")));
  it("non-JSON -> 400 -32700", async () => {
    const r = await rpc("tok_admin", sid, "{not json");
    expect(r.status).toBe(400);
    expect(r.msgs[0].error.code).toBe(-32700);
  });
  it("params.name as a number -> 400 -32600", async () => {
    const before = downstreamCalls().length;
    const r = await rpc("tok_admin", sid, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: 123 } });
    expect(r.status).toBe(400);
    expect(r.msgs[0].error.code).toBe(-32600);
    expect(downstreamCalls().length).toBe(before);
  });
  it("a batch containing a blocked call is refused as a whole", async () => {
    const vs = await initialize("tok_viewer");
    const r = await rpc("tok_viewer", vs, [
      { jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "echo", arguments: { message: "x" } } },
      { jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "admin_reset_key", arguments: {} } },
    ]);
    expect(r.msgs.map((m) => [m.id, m.error.code])).toEqual([[20, -32600], [21, -32001]]);
  });
});

describe("official SDK client through the gateway", () => {
  it("viewer: listTools works, admin tool rejects with -32001", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(GW), { requestInit: { headers: { authorization: "Bearer tok_viewer" } } });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(transport);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("echo");
    await expect(client.callTool({ name: "admin_reset_key", arguments: {} })).rejects.toMatchObject({ code: -32001 });
    await client.close();
  });
});
