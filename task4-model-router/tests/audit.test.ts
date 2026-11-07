// Regressions from the production-readiness audit.
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
beforeAll(() => { if (!existsSync(resolve(root, "dist/server.js"))) execSync("npm run build", { cwd: root, stdio: "inherit" }); });

describe("separate OS processes sharing one SQLite file", () => {
  it("20 x 5000-token reservations from 4 processes admit exactly 10 (limit 50,000)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t4-mp-"));
    const dbPath = join(dir, "shared.db");
    openDb(dbPath).close(); // create the schema once, up front
    const worker = `
      import { openDb } from ${JSON.stringify(resolve(root, "dist/db.js"))};
      import { TokenLimiter } from ${JSON.stringify(resolve(root, "dist/limiter.js"))};
      const l = new TokenLimiter(openDb(process.argv[1]), { limit: 50000, windowMs: 60000 });
      let ok = 0;
      for (let i = 0; i < 5; i++) if (l.tryReserve("burst", 5000).ok) ok++;
      console.log(ok);`;
    const run = () => new Promise<number>((res, rej) => {
      const c = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", worker, dbPath], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      c.stdout!.on("data", (d) => (out += d));
      c.on("error", rej);
      c.on("close", (code) => (code === 0 ? res(Number(out.trim())) : rej(new Error("worker exit " + code))));
    });
    const admitted = (await Promise.all([run(), run(), run(), run()])).reduce((a, b) => a + b, 0);
    expect(admitted).toBe(10);
    const db = openDb(dbPath);
    expect((db.prepare("SELECT COUNT(*) AS n FROM usage WHERE tenant='burst'").get() as { n: number }).n).toBe(10);
    db.close();
  });
});

describe("cold start", () => {
  it("six processes opening the same brand-new database file at once all succeed", async () => {
    for (let round = 0; round < 3; round++) {
      const path = join(mkdtempSync(join(tmpdir(), "t4-cold-")), "x.db");
      const code = `import { openDb } from ${JSON.stringify(resolve(root, "dist/db.js"))}; openDb(process.argv[1]).close();`;
      const results = await Promise.all(Array.from({ length: 6 }, () => new Promise<{ code: number | null; err: string }>((res) => {
        const c = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", code, path], { stdio: ["ignore", "ignore", "pipe"] });
        let err = "";
        c.stderr!.on("data", (d) => (err += d));
        c.on("close", (code) => res({ code, err }));
      })));
      for (const r of results) expect(r, r.err).toMatchObject({ code: 0 });
    }
  });
});

describe("API keys are not written to logs", () => {
  let mock: ChildProcess, router: ChildProcess;
  let logs = "";
  const SECRET = "sk-live-SUPERSECRET-123";
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "t4-log-"));
    mock = spawn(process.execPath, [resolve(root, "dist/mock-provider/server.js")], { env: { ...process.env, MOCK_PROVIDER_PORT: "14210" }, stdio: "ignore" });
    router = spawn(process.execPath, ["--no-warnings", resolve(root, "dist/server.js")], {
      env: { ...process.env, ROUTER_PORT: "13210", DB_PATH: join(dir, "x.db"), PRIMARY_URL: "http://localhost:14210/primary", SECONDARY_URL: "http://localhost:14210/secondary", TOKEN_LIMIT: "100" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    router.stderr!.on("data", (d) => (logs += d));
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch("http://localhost:13210/readyz")).ok) return; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("router did not start");
  });
  afterAll(() => { router.kill("SIGTERM"); mock.kill("SIGTERM"); });

  it("neither a success nor a 429 log line contains the key", async () => {
    const h = { "content-type": "application/json", "x-api-key": SECRET };
    expect((await fetch("http://localhost:13210/v1/complete", { method: "POST", headers: h, body: JSON.stringify({ prompt: "hi", max_tokens: 10 }) })).status).toBe(200);
    expect((await fetch("http://localhost:13210/v1/complete", { method: "POST", headers: h, body: JSON.stringify({ prompt: "hi", max_tokens: 10, estimated_tokens: 95 }) })).status).toBe(429);
    await new Promise((r) => setTimeout(r, 100));
    expect(logs).toContain("request.ok");
    expect(logs).toContain("rate_limited");
    expect(logs).not.toContain(SECRET);
  });
});
