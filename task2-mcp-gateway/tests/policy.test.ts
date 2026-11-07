import { describe, expect, it } from "vitest";
import { decide } from "../src/gateway/policy.js";
import { extractBearer, resolveRole, tokensFromEnv } from "../src/gateway/auth.js";

const call = (name: unknown, id: unknown = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });

describe("policy.decide", () => {
  it("allows tools/list for any role", () => {
    expect(decide("viewer", { jsonrpc: "2.0", id: 1, method: "tools/list" }).kind).toBe("allow");
  });
  it("allows non-admin tools for viewer", () => {
    expect(decide("viewer", call("echo")).kind).toBe("allow");
  });
  it("denies admin_* for viewer and keeps the request id", () => {
    expect(decide("viewer", call("admin_reset_key", 7))).toEqual({ kind: "deny", id: 7, tool: "admin_reset_key", required: "admin" });
  });
  it("allows admin_* for admin", () => {
    expect(decide("admin", call("admin_reset_key")).kind).toBe("allow");
  });
  it("is prefix-exact", () => {
    expect(decide("viewer", call("administrator_lookup")).kind).toBe("allow");
  });
  it("forwards notifications (no id)", () => {
    expect(decide("viewer", { jsonrpc: "2.0", method: "notifications/initialized" }).kind).toBe("allow");
  });
  it("rejects tools/call without a string params.name", () => {
    expect(decide("admin", call(42)).kind).toBe("invalid");
    expect(decide("admin", { jsonrpc: "2.0", id: 1, method: "tools/call" }).kind).toBe("invalid");
  });
  it("rejects non-objects and wrong jsonrpc version", () => {
    expect(decide("admin", "string").kind).toBe("invalid");
    expect(decide("admin", { jsonrpc: "1.0", id: 1, method: "tools/list" }).kind).toBe("invalid");
  });
});

describe("auth", () => {
  const tokens = tokensFromEnv({ STATIC_TOKENS: "tok_admin:admin,tok_viewer:viewer" } as NodeJS.ProcessEnv);
  it("extracts only well-formed bearer tokens", () => {
    expect(extractBearer("Bearer abc")).toBe("abc");
    expect(extractBearer("bearer abc")).toBe("abc");
    expect(extractBearer("Bearer ")).toBeNull();
    expect(extractBearer("Basic abc")).toBeNull();
    expect(extractBearer(undefined)).toBeNull();
  });
  it("unknown token -> null, never a default role", () => {
    expect(resolveRole("tok_admin", tokens)).toBe("admin");
    expect(resolveRole("tok_viewer", tokens)).toBe("viewer");
    expect(resolveRole("tok_nope", tokens)).toBeNull();
    expect(resolveRole(null, tokens)).toBeNull();
  });
});
