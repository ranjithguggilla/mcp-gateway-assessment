// Spawns the real binary and reads its stdout; calling the handler directly would not prove stdio isolation.
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = resolve(root, "dist/server.js");
const fixture = resolve(root, "fixtures/session.jsonl");

type Msg = { jsonrpc: string; id?: number; result?: any; error?: { code: number; message: string; data?: any } };

function run(input: string): Promise<{ lines: string[]; stderr: string; code: number | null }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [bin], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", rej);
    child.on("close", (code) => res({ lines: out.split("\n").filter(Boolean), stderr: err, code }));
    child.stdin.end(input);
  });
}

describe("task1 stdio server", () => {
  let lines: string[], stderr: string, code: number | null;
  const byId = new Map<number, Msg>();

  beforeAll(async () => {
    if (!existsSync(bin)) execSync("npm run build", { cwd: root, stdio: "inherit" });
    ({ lines, stderr, code } = await run(readFileSync(fixture, "utf8")));
    for (const l of lines) {
      const m = JSON.parse(l) as Msg;
      if (m.id !== undefined) byId.set(m.id, m);
    }
  });

  it("exits 0 when stdin closes", () => expect(code).toBe(0));

  it("every stdout line is a JSON-RPC 2.0 message", () => {
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(JSON.parse(l).jsonrpc).toBe("2.0");
  });

  it("stderr has JSON logs and no frames", () => {
    expect(stderr).toContain("server.started");
    for (const l of stderr.split("\n").filter(Boolean)) expect(JSON.parse(l).jsonrpc).toBeUndefined();
  });

  it("tools/list advertises both tools with constraints", () => {
    const tools = byId.get(2)!.result.tools;
    expect(tools.map((t: any) => t.name).sort()).toEqual(["get_customer_record", "trigger_refund"]);
    const refund = tools.find((t: any) => t.name === "trigger_refund");
    expect(refund.inputSchema.properties.customer_id.pattern).toBe("^CUST-\\d{5}$");
    expect(refund.inputSchema.properties.reason.minLength).toBe(10);
  });

  it("valid calls succeed", () => {
    expect(byId.get(3)!.result.structuredContent.customer_id).toBe("CUST-12345");
    expect(byId.get(4)!.result.structuredContent.amount).toBe(25.5);
  });

  it.each([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])("malformed call id=%i -> -32602", (id) => {
    const m = byId.get(id)!;
    expect(m.result).toBeUndefined();
    expect(m.error?.code).toBe(-32602);
    expect(m.error?.data?.issues?.length).toBeGreaterThan(0);
  });

  it("business failures are isError results, not protocol errors", () => {
    expect(byId.get(20)!.result.isError).toBe(true);
    expect(byId.get(21)!.result.isError).toBe(true);
    expect(byId.get(21)!.result.content[0].text).toContain("CUSTOMER_SUSPENDED");
  });

  it("unknown tool -> -32602, unknown method -> -32601", () => {
    expect(byId.get(22)!.error?.code).toBe(-32602);
    expect(byId.get(23)!.error?.code).toBe(-32601);
  });

  it("garbage on stdin does not kill the server or pollute stdout", async () => {
    const init = readFileSync(fixture, "utf8").split("\n")[0];
    const r = await run(`${init}\nthis is not json\n{"jsonrpc":"2.0","id":99,"method":"tools/list"}\n`);
    expect(r.code).toBe(0);
    for (const l of r.lines) JSON.parse(l);
  });
});
