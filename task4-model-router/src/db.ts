import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * On-disk SQLite via node:sqlite (built into Node 22.13+; no native build step).
 * WAL + busy_timeout so a second process opening the same file waits instead
 * of failing with SQLITE_BUSY.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * SQLite can answer SQLITE_BUSY immediately, without calling the busy handler, when another connection is
 * in the middle of switching the same file to WAL (it does this to avoid a deadlock). busy_timeout therefore
 * does not cover first-open races, so retry those statements with a small jittered sleep.
 */
function retryLocked<T>(fn: () => T, tries = 200): T {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (i >= tries || !/locked|busy/i.test(String((e as Error).message))) throw e;
      sleepSync(5 + Math.random() * 20);
    }
  }
}

export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // busy_timeout must come first: switching to WAL needs a lock, and without a busy handler a second
  // process starting at the same moment fails immediately with "database is locked".
  db.exec("PRAGMA busy_timeout=5000");
  retryLocked(() => db.exec("PRAGMA journal_mode=WAL"));
  db.exec("PRAGMA synchronous=NORMAL");
  retryLocked(() => db.exec(`
    CREATE TABLE IF NOT EXISTS usage (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant    TEXT    NOT NULL,
      ts_ms     INTEGER NOT NULL,
      tokens    INTEGER NOT NULL,
      state     TEXT    NOT NULL CHECK (state IN ('reserved','final')),
      provider  TEXT,
      request_id TEXT
    );
    CREATE INDEX IF NOT EXISTS usage_tenant_ts ON usage (tenant, ts_ms);
  `));
  return db;
}
