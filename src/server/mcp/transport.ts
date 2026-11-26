/**
 * MCP over Streamable HTTP, stateless and JSON-only (the pattern of Daniel's other
 * connectors): each JSON-RPC request arrives by POST and is answered in one JSON
 * body. No session, no SSE stream, no batch and no server-initiated message, so
 * nothing leaves after the authorization check for that request.
 */
import { z } from "zod";
import { AccessDenied } from "@/server/access/policy";
import { InvalidInput, NotFound } from "@/server/care/validate";
import { INSTRUCTIONS, SERVER_INFO } from "./instructions";
import { TOOLS, type Tool, type ToolDeps } from "./tools";

export const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
const DEFAULT_VERSION = "2025-06-18";
const NEWEST = [...SUPPORTED_VERSIONS].sort().at(-1)!;
const VERSION_SHAPE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const MAX_RESULT_CHARS = 200_000;

/** An MCP-Protocol-Version header may proceed when it is supported, or well-formed and newer (handled as the newest). */
export function protocolHeaderAccepted(value: string): boolean {
  return (SUPPORTED_VERSIONS as readonly string[]).includes(value) || (VERSION_SHAPE.test(value) && value > NEWEST);
}

type Id = string | number;
export type Rpc = { jsonrpc: "2.0"; id: Id | null } & ({ result: unknown } | { error: { code: number; message: string } });
export type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError: boolean };

const validId = (id: unknown): id is Id => (typeof id === "string" && id.length <= 200) || (typeof id === "number" && Number.isSafeInteger(id));
const rpcError = (id: unknown, code: number, message: string): Rpc => ({ jsonrpc: "2.0", id: validId(id) ? id : null, error: { code, message } });
const rpcResult = (id: Id, result: unknown): Rpc => ({ jsonrpc: "2.0", id, result });
const refusal = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** What tools/list sends for each tool. */
export function describeTools(tools: readonly Tool[] = TOOLS) {
  return tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: z.toJSONSchema(t.input), annotations: { title: t.title, ...t.annotations } }));
}

/** A calm message for each kind of refusal, the same ones the web app shows. Never the input: it may be pastoral text. */
function refusalFor(tool: Tool, error: unknown): ToolResult {
  if (error instanceof AccessDenied) return refusal("You do not have access to do that.");
  if (error instanceof InvalidInput) return refusal("Please check the values and try again.");
  if (error instanceof NotFound) return refusal("That could not be found. Find the person first, or it may have been closed or moved.");
  console.error("Connector tool failed", tool.name, error instanceof Error ? error.name : "unknown");
  return refusal("Something went wrong. Please try again.");
}

export async function callTool(tool: Tool, args: unknown, deps: ToolDeps): Promise<ToolResult> {
  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) {
    // Field names only; a value could be a note.
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "arguments"))].join(", ");
    return refusal(`Please check these values and try again: ${fields}.`);
  }
  try {
    const out = await tool.run(deps, parsed.data as never);
    const text = JSON.stringify(out);
    if (text.length > MAX_RESULT_CHARS) return refusal("The result is too large; narrow the request.");
    return { content: [{ type: "text", text }], structuredContent: out, isError: false };
  } catch (error) {
    return refusalFor(tool, error);
  }
}

/** Answer one JSON-RPC message for an authorised actor. Null: nothing to answer (a notification or a client response). */
export async function answerRpc(body: unknown, deps: ToolDeps, tools: readonly Tool[] = TOOLS): Promise<Rpc | null> {
  if (Array.isArray(body)) return rpcError(null, -32600, "Batches are not accepted; send one request at a time.");
  if (!body || typeof body !== "object") return rpcError(null, -32600, "Invalid Request");
  const msg = body as Record<string, unknown>;
  if (msg.jsonrpc === "2.0" && !Object.hasOwn(msg, "method") && (Object.hasOwn(msg, "result") || Object.hasOwn(msg, "error"))) return null;
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg.id, -32600, "Invalid Request");
  if (!Object.hasOwn(msg, "id")) return null;
  if (!validId(msg.id)) return rpcError(null, -32600, "Invalid Request");
  const id = msg.id;
  const params = msg.params && typeof msg.params === "object" && !Array.isArray(msg.params) ? (msg.params as Record<string, unknown>) : {};
  switch (msg.method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const protocolVersion = typeof asked === "string" && (SUPPORTED_VERSIONS as readonly string[]).includes(asked) ? asked : DEFAULT_VERSION;
      return rpcResult(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: describeTools(tools) });
    case "tools/call": {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) return rpcError(id, -32602, "Unknown tool");
      return rpcResult(id, await callTool(tool, params.arguments, deps));
    }
    default:
      return rpcError(id, -32601, "Method not found");
  }
}
