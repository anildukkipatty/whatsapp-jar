import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import { config } from "./config";

/**
 * Connects Jar to one remote MCP server (Streamable HTTP, no authentication),
 * so the agent can use that server's tools from any channel. Built for
 * slash-dhan-mcp: the server's tools are offered to the model as they are, and
 * its SKILL.md, the guide to using them, goes into the system prompt.
 *
 * Both are loaded once per process. They sit at the front of the prompt, so
 * they must not change between turns or the prompt cache is rewritten.
 */

export type Mcp = { tools: ToolSet; prompt: string };

const NONE: Mcp = { tools: {}, prompt: "" };
const RETRY_AFTER_MS = 30_000;
const LOAD_TIMEOUT_MS = 15_000;
// Longer than the slowest tool the server offers (run_python allows 180 s).
const CALL_TIMEOUT_MS = 200_000;
// A tool result stays in the thread's history, so a runaway one is cut short.
const MAX_RESULT_CHARS = 20_000;

type RpcTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };
type RpcContent = { type: string; text?: string };

let loaded: Mcp | null = null;
let loading: Promise<Mcp> | null = null;
let failedAt = 0;
let rpcId = 0;

async function rpc<T>(url: string, method: string, params: unknown, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal,
  });
  if (!response.ok) throw new Error(`MCP ${method} failed with HTTP ${response.status}`);
  const raw = await response.text();
  // A server may answer a single request as a one-event stream.
  const json = response.headers.get("content-type")?.includes("text/event-stream")
    ? raw.split("\n").findLast((line) => line.startsWith("data:"))?.slice(5)
    : raw;
  const body = JSON.parse(json ?? "null") as { result?: T; error?: { message?: string } } | null;
  if (!body || body.error || body.result === undefined) {
    throw new Error(`MCP ${method} failed: ${body?.error?.message ?? "no result"}`);
  }
  return body.result;
}

function callTool(url: string, name: string) {
  return async (input: unknown, options: { abortSignal?: AbortSignal }) => {
    const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
    const signal = options.abortSignal ? AbortSignal.any([options.abortSignal, timeout]) : timeout;
    try {
      const result = await rpc<{ content?: RpcContent[]; isError?: boolean }>(
        url,
        "tools/call",
        { name, arguments: input ?? {} },
        signal,
      );
      let text = (result.content ?? [])
        .map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type} content not shown]`))
        .join("\n");
      if (text.length > MAX_RESULT_CHARS) {
        text = `${text.slice(0, MAX_RESULT_CHARS)}\n[output cut at ${MAX_RESULT_CHARS} characters; print less]`;
      }
      return result.isError ? `ERROR\n${text}` : text || "(no output)";
    } catch (error) {
      // The model gets the failure as a result, so it can tell the user instead of the turn dying.
      if (options.abortSignal?.aborted) throw error;
      return `ERROR\nThe tool could not be reached: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
}

async function fetchSkill(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (response.status === 404) return "";
  if (!response.ok) throw new Error(`Skill guide failed with HTTP ${response.status}`);
  // Drop the YAML front matter: it is metadata for skill uploads, not guidance.
  return (await response.text()).replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

async function load(url: string): Promise<Mcp> {
  const signal = AbortSignal.timeout(LOAD_TIMEOUT_MS);
  const [init, list, skill] = await Promise.all([
    rpc<{ instructions?: string; serverInfo?: { name?: string } }>(
      url,
      "initialize",
      { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "whatsapp-jar", version: "0.1.0" } },
      signal,
    ),
    rpc<{ tools: RpcTool[] }>(url, "tools/list", {}, signal),
    fetchSkill(config.mcpSkillUrl || new URL("SKILL.md", url).href, signal),
  ]);

  const allowed = config.mcpTools;
  const tools: ToolSet = {};
  for (const entry of list.tools) {
    if (allowed.size && !allowed.has(entry.name)) continue;
    tools[entry.name] = dynamicTool({
      description: entry.description ?? "",
      inputSchema: jsonSchema(entry.inputSchema ?? { type: "object", properties: {} }),
      execute: callTool(url, entry.name),
    });
  }
  const names = Object.keys(tools);
  if (!names.length) return NONE;

  const prompt = [
    `## Connected tools: ${init.serverInfo?.name || "MCP server"}`,
    `You also have these tools from a connected server: ${names.join(", ")}. Use them whenever a question needs what they provide, instead of answering from memory.`,
    init.instructions?.trim(),
    "Their results are for you, not the user. Reply with the answer in chat style: short lines, no tables and no code blocks, because the chat app shows them as raw characters.",
    skill && `What follows is the server's own guide to these tools.\n\n${skill}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { tools, prompt };
}

/**
 * The connected server's tools and prompt section, or nothing when no server is
 * configured or it can't be reached. Jar keeps working without them, and tries
 * the server again after a short wait.
 */
export async function loadMcp(): Promise<Mcp> {
  const url = config.mcpUrl;
  if (!url) return NONE;
  if (loaded) return loaded;
  if (Date.now() - failedAt < RETRY_AFTER_MS) return NONE;
  loading ??= load(url)
    .then((mcp) => (loaded = mcp))
    .catch((error) => {
      failedAt = Date.now();
      console.error("[mcp] could not load tools, continuing without them:", error);
      return NONE;
    })
    .finally(() => (loading = null));
  return loading;
}

/** For tests: forget what was loaded. */
export function resetMcp() {
  loaded = null;
  loading = null;
  failedAt = 0;
}
