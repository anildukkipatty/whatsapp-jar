import { createMCPClient, type CallToolResult, type MCPClient } from "@ai-sdk/mcp";
import { jsonSchema, tool, type Tool } from "ai";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config";

type ServerConfig = { url: string; headers?: Record<string, string> };

export type McpServer = { name: string; instructions?: string; tools: Record<string, Tool> };

/** A server that failed to connect is left alone this long before the next try. */
const RETRY_CONNECT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;
/** run_python allows scripts up to 180 s, so a call gets a little longer than that. */
const CALL_TIMEOUT_MS = 200_000;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

type Connection = { key: string; client: MCPClient; server: McpServer };

const globals = globalThis as unknown as {
  jarMcp?: { connections: Map<string, Promise<Connection>>; failedAt: Map<string, number> };
};
const state = (globals.jarMcp ??= { connections: new Map(), failedAt: new Map() });

/**
 * Reads the server list on every turn, so editing it needs no restart. Missing
 * file or MCP_CONFIG="" means no servers. `${VAR}` in a header value is read
 * from the environment, so tokens can stay in .env.
 */
export function loadMcpConfig(): Record<string, ServerConfig> {
  const path = config.mcpConfigPath;
  if (!path) return {};
  let raw: string;
  try {
    raw = readFileSync(resolve(path), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const servers = (JSON.parse(raw) as { mcpServers?: Record<string, ServerConfig> }).mcpServers ?? {};
  const expand = (value: string) => value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      {
        url: server.url,
        headers: server.headers && Object.fromEntries(Object.entries(server.headers).map(([k, v]) => [k, expand(v)])),
      },
    ]),
  );
}

/** Text content joined, capped so one call can't flood the context or the stored window. */
export function toModelText(result: CallToolResult) {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((part) => (part.type === "text" ? part.text : `[${part.type} content omitted]`))
    .join("\n");
  const limit = config.maxToolOutputChars;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[Output truncated: ${text.length.toLocaleString("en")} characters, showing the first ${limit.toLocaleString("en")}. Print less.]`;
}

function forget(key: string) {
  const connection = state.connections.get(key);
  state.connections.delete(key);
  connection?.then((c: Connection) => c.client.close()).catch(() => {});
}

async function connect(name: string, server: ServerConfig, key: string): Promise<Connection> {
  const client = await createMCPClient({
    transport: { type: "http", url: server.url, headers: server.headers },
    clientName: "whatsapp-jar",
    initializationOptions: { timeout: CONNECT_TIMEOUT_MS },
    onUncaughtError: (error) => console.error(`[mcp] ${name}:`, error),
  });
  try {
    const definitions = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools({
        params: cursor ? { cursor } : undefined,
        options: { timeout: CONNECT_TIMEOUT_MS },
      });
      definitions.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);

    const tools: Record<string, Tool> = {};
    for (const definition of definitions) {
      const toolName = definition.name;
      tools[toolName] = tool({
        description: definition.description ?? "",
        inputSchema: jsonSchema(definition.inputSchema as Parameters<typeof jsonSchema>[0]),
        execute: async (input, { abortSignal }) => {
          try {
            const result = await client.callTool({
              name: toolName,
              arguments: input as Record<string, unknown>,
              options: { signal: abortSignal, timeout: CALL_TIMEOUT_MS },
            });
            const text = toModelText(result);
            return result.isError ? { error: text || "The tool reported an error." } : text;
          } catch (error) {
            if (abortSignal?.aborted) throw error;
            // A broken session or transport: reconnect on the next turn.
            forget(key);
            console.error(`[mcp] ${name}.${toolName} failed:`, error);
            return { error: `The ${name} service could not be reached: ${(error as Error).message}` };
          }
        },
      });
    }
    return { key, client, server: { name, instructions: client.instructions?.trim() || undefined, tools } };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

/**
 * Connected servers, in config order. Connections and tool lists are kept for
 * the life of the process, so the tool definitions sent to the model stay
 * byte-identical between turns and the prompt cache holds. A server that is
 * down is skipped for this turn and retried later, so the chat keeps working.
 */
export async function mcpServers(): Promise<McpServer[]> {
  const servers = loadMcpConfig();
  const wanted = new Set<string>();
  const results: McpServer[] = [];
  for (const [name, server] of Object.entries(servers)) {
    const key = JSON.stringify([name, server]);
    wanted.add(key);
    if (!state.connections.has(key)) {
      if (Date.now() - (state.failedAt.get(key) ?? 0) < RETRY_CONNECT_MS) continue;
      state.connections.set(key, connect(name, server, key));
    }
    try {
      results.push((await state.connections.get(key)!).server);
      state.failedAt.delete(key);
    } catch (error) {
      console.error(`[mcp] could not connect to ${name} (${server.url}):`, error);
      state.connections.delete(key);
      state.failedAt.set(key, Date.now());
    }
  }
  for (const key of state.connections.keys()) if (!wanted.has(key)) forget(key);
  return results;
}

/**
 * MCP tools keyed by the name the model sees. A server's own tool names are
 * kept, since its instructions and skills refer to them. A name that clashes
 * with a built-in tool or an earlier server gets the server name in front.
 */
export function mcpToolSet(servers: McpServer[], taken: Iterable<string>): Record<string, Tool> {
  const used = new Set(taken);
  const tools: Record<string, Tool> = {};
  for (const server of servers) {
    for (const [name, definition] of Object.entries(server.tools)) {
      let exposed = name;
      if (used.has(exposed) || !TOOL_NAME.test(exposed)) {
        exposed = `${server.name}__${name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
      }
      if (used.has(exposed)) {
        console.error(`[mcp] skipping ${server.name}.${name}: the name ${exposed} is already taken`);
        continue;
      }
      used.add(exposed);
      tools[exposed] = definition;
    }
  }
  return tools;
}

/** For tests: drop every connection so the next turn reconnects. */
export async function resetMcp() {
  const connections = [...state.connections.values()];
  state.connections.clear();
  state.failedAt.clear();
  await Promise.allSettled(connections.map(async (c) => (await c).client.close()));
}
