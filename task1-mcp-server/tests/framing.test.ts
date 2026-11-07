// Regression tests for malformed input that the SDK's stock stdio transport swallowed or mapped to -32603.
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = resolve(root, "dist/server.js");

function run(lines: string[]): Promise<any[]> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [bin], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", rej);
    child.on("close", () => res(out.split("\n").filter(Boolean).map((l) => JSON.parse(l))));
    child.stdin.end(lines.join("\n") + "\n");
  });
}

const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
const call = (id: number, params: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params });

describe("task1 framing and shape errors", () => {
  beforeAll(() => { if (!existsSync(bin)) execSync("npm run build", { cwd: root, stdio: "inherit" }); });

  it.each([
    ["arguments null", { name: "get_customer_record", arguments: null }],
    ["arguments array", { name: "get_customer_record", arguments: [] }],
    ["name not a string", { name: 5, arguments: {} }],
    ["name empty", { name: "", arguments: {} }],
  ])("%s -> -32602 without a zod dump", async (_n, params) => {
    const r = (await run([init, call(2, params)])).find((m) => m.id === 2);
    expect(r.error.code).toBe(-32602);
    expect(JSON.stringify(r)).not.toMatch(/ZodError|invalid_type/);
  });

  it("params is an array -> -32600 (not a valid JSON-RPC request)", async () => {
    const r = (await run([init, call(2, [])])).find((m) => m.id === 2);
    expect(r.error.code).toBe(-32600);
  });

  it("missing params -> -32602", async () => {
    const r = (await run([init, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call" })])).find((m) => m.id === 2);
    expect(r.error.code).toBe(-32602);
  });

  it("non-JSON line -> -32700 with null id, server keeps serving", async () => {
    const out = await run([init, "this is not json", JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })]);
    expect(out.find((m) => m.error?.code === -32700)?.id).toBeNull();
    expect(out.find((m) => m.id === 3)?.result.tools.length).toBeGreaterThan(0);
  });

  it("not JSON-RPC 2.0 -> -32600", async () => {
    const out = await run([JSON.stringify({ id: 9, method: "tools/list" })]);
    expect(out[0].error.code).toBe(-32600);
    expect(out[0].id).toBe(9);
  });

  it("batch array -> -32600", async () => {
    const out = await run([JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }])]);
    expect(out[0].error.code).toBe(-32600);
  });

  it("stdout holds only JSON-RPC frames after hostile input", async () => {
    const out = await run([init, "{", "[]", "\u0000", call(2, { name: "nope", arguments: {} })]);
    for (const m of out) expect(m.jsonrpc).toBe("2.0");
  });
});
