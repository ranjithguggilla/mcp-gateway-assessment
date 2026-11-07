import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * On-disk SQLite via node:sqlite (built into Node 22.13+; no native build step).
 * WAL + busy_timeout so a second process opening the same file waits instead
 * of failing with SQLITE_BUSY.
 */
export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // busy_timeout must come first: switching to WAL needs a lock, and without a busy handler a second
  // process starting at the same moment fails immediately with "database is locked".
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec(`
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
  `);
  return db;
}
