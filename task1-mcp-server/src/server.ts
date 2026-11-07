#!/usr/bin/env node
import "./harden.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import { log } from "./log.js";
import { GetCustomerRecordSchema, TriggerRefundSchema } from "./schemas.js";
import { createRefund, getCustomer } from "./store.js";

// Why the low-level Server and not McpServer.registerTool: in SDK 1.x McpServer catches every
// failure inside a tools/call handler, including zod input validation, and returns it as a
// CallToolResult with isError: true. The brief requires malformed input to be a protocol error
// (-32602) and only business failures to be isError results. Owning the handler draws that line.

interface ToolDef {
  tool: Tool;
  schema: ZodTypeAny;
  handler: (args: any) => Promise<CallToolResult>;
}

function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}
function businessError(code: string, message: string): CallToolResult {
  return { content: [{ type: "text", text: `${code}: ${message}` }], isError: true };
}

const TOOLS: Record<string, ToolDef> = {
  get_customer_record: {
    schema: GetCustomerRecordSchema,
    tool: {
      name: "get_customer_record",
      description: "Look up a customer by id. customer_id must match CUST-XXXXX (five digits).",
      inputSchema: zodToJsonSchema(GetCustomerRecordSchema, { $refStrategy: "none" }) as Tool["inputSchema"],
    },
    handler: async ({ customer_id }) => {
      const c = getCustomer(customer_id);
      log("info", "tool.call", { tool: "get_customer_record", customer_id, found: !!c });
      if (!c) return businessError("CUSTOMER_NOT_FOUND", `No customer with id ${customer_id}`);
      return ok({ ...c });
    },
  },
  trigger_refund: {
    schema: TriggerRefundSchema,
    tool: {
      name: "trigger_refund",
      description: "Refund a customer. amount must be a positive finite number; reason at least 10 characters after trimming.",
      inputSchema: zodToJsonSchema(TriggerRefundSchema, { $refStrategy: "none" }) as Tool["inputSchema"],
    },
    handler: async (args) => {
      const r = createRefund(args);
      log("info", "tool.call", { tool: "trigger_refund", customer_id: args.customer_id, amount: args.amount, ok: r.ok });
      if (!r.ok) {
        const code = { not_found: "CUSTOMER_NOT_FOUND", suspended: "CUSTOMER_SUSPENDED", insufficient_balance: "INSUFFICIENT_BALANCE" }[r.reason];
        return businessError(code, r.detail);
      }
      return ok({ ...r.refund, replayed: r.replayed });
    },
  },
};

export function buildServer(): Server {
  const server = new Server({ name: "customer-ops", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Object.values(TOOLS).map((t) => t.tool) }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const def = TOOLS[name];
    if (!def) throw new McpError(ErrorCode.InvalidParams, `Tool ${name} not found`);

    // Validate before the handler touches any data.
    const parsed = def.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message, code: i.code }));
      log("warn", "tool.invalid_params", { tool: name, issues });
      throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for tool ${name}`, { tool: name, issues });
    }
    try {
      return await def.handler(parsed.data);
    } catch (err) {
      log("error", "tool.crash", { tool: name, error: err instanceof Error ? err.message : String(err) });
      throw new McpError(ErrorCode.InternalError, `Tool ${name} failed`);
    }
  });
  return server;
}

async function main(): Promise<void> {
  const server = buildServer();
  const shutdown = async (why: string) => {
    log("info", "shutdown", { why });
    try { await server.close(); } finally { process.exit(0); }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.stdin.on("end", () => void shutdown("stdin_end"));

  await server.connect(new StdioServerTransport());
  log("info", "server.started", { name: "customer-ops", transport: "stdio", pid: process.pid });
}

main().catch((err) => {
  log("error", "fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
