import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { db } from "../src/core/db";
import { getOrCreateThread, receiveMessage, type ThreadRef } from "../src/core/messages";
import { idle, tick } from "../src/core/worker";

export type Block = Record<string, any>;
export type Request = {
  system: Block[] | string;
  messages: { role: string; content: Block[] | string }[];
  tools?: Block[];
  tool_choice?: Block;
  thinking?: Block;
  output_config?: Block;
  fallbacks?: unknown;
  [key: string]: unknown;
};
export type Reply = {
  status?: number;
  content?: Block[];
  stop_reason?: string;
  error?: string;
  usage?: Block;
  model?: string;
  stop_details?: Block;
};

/** Stands in for api.anthropic.com. The real provider and agent loop talk to it over HTTP. */
export class FakeAnthropic {
  requests: Request[] = [];
  headers: Record<string, string | string[] | undefined>[] = [];
  problems: string[] = [];
  inFlight = 0;
  maxInFlight = 0;
  handler: (request: Request, index: number) => Reply | Promise<Reply> = () => text("ok");
  private server?: Server;

  async start() {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Request;
      const index = this.requests.length;
      this.requests.push(body);
      this.headers.push(req.headers);
      this.problems.push(...validate(body).map((p) => `request ${index}: ${p}`));
      this.inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      const reply = await this.handler(body, index);
      this.inFlight--;
      res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      if (reply.status && reply.status >= 400) {
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: reply.error ?? "boom" } }));
        return;
      }
      const content = reply.content ?? [];
      res.end(
        JSON.stringify({
          id: `msg_${index}`,
          type: "message",
          role: "assistant",
          model: reply.model ?? body.model,
          content,
          stop_reason: reply.stop_reason ?? (content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"),
          stop_sequence: null,
          stop_details: reply.stop_details ?? null,
          usage: reply.usage ?? { input_tokens: 10, output_tokens: 10 },
        }),
      );
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}/v1`;
    process.env.ANTHROPIC_API_KEY = "test-key-for-fake-server";
  }

  reset() {
    this.requests = [];
    this.headers = [];
    this.problems = [];
    this.maxInFlight = 0;
    this.handler = () => text("ok");
  }

  stop() {
    this.server?.close();
  }
}

/** The structural rules the real API enforces with a 400. */
function validate(body: Request) {
  const problems: string[] = [];
  if (body.messages[0]?.role !== "user") problems.push("first message is not from the user");
  const open = new Set<string>();
  body.messages.forEach((message, index) => {
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    if (!blocks.length) problems.push(`message ${index} is empty`);
    if (blocks.some((b) => b.type === "text" && !b.text)) problems.push(`message ${index} has an empty text block`);
    if (message.role === "user") {
      for (const block of blocks) {
        if (block.type === "tool_result" && !open.delete(block.tool_use_id)) {
          problems.push(`tool_result ${block.tool_use_id} has no matching tool_use`);
        }
      }
      if (open.size) problems.push(`tool_use without a tool_result before message ${index}`);
    } else {
      if (open.size) problems.push(`tool_use without a tool_result before message ${index}`);
      for (const block of blocks) if (block.type === "tool_use") open.add(block.id);
    }
  });
  if (open.size) problems.push("request ends on an unanswered tool_use");
  return problems;
}

export const text = (value: string): Reply => ({ content: [{ type: "text", text: value }] });

let toolIds = 0;
export const toolUse = (name: string, input: Block, ...rest: Block[]): Reply => ({
  content: [...rest, { type: "tool_use", id: `toolu_${++toolIds}`, name, input }],
});

export function allText(request: Request) {
  return JSON.stringify(request.messages);
}

export function systemText(request: Request) {
  return typeof request.system === "string" ? request.system : request.system.map((b) => b.text).join("\n");
}

export function toolResult(request: Request) {
  const blocks = request.messages.at(-1)!.content as Block[];
  return JSON.stringify(blocks.find((b) => b.type === "tool_result"));
}

export async function resetDb() {
  await db().query("TRUNCATE tenants, users, threads, turns, messages RESTART IDENTITY CASCADE");
}

export async function makeUser(tenantName: string, userName: string): Promise<ThreadRef> {
  const tenant = await db().query(
    `WITH found AS (SELECT id FROM tenants WHERE name = $1),
          made AS (INSERT INTO tenants (name) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM found) RETURNING id)
     SELECT id FROM found UNION ALL SELECT id FROM made`,
    [tenantName],
  );
  const tenantId = tenant.rows[0].id;
  const user = await db().query("INSERT INTO users (tenant_id, name) VALUES ($1, $2) RETURNING id", [
    tenantId,
    userName,
  ]);
  return getOrCreateThread(tenantId, user.rows[0].id);
}

export const send = (ref: ThreadRef, text: string, replyToId?: number) =>
  receiveMessage(ref, { text, dedupeKey: randomUUID(), replyToId });

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs the worker until nothing is left to do, or until the time limit. */
export async function drain(limitMs = 5000) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    await tick();
    await idle();
    const { rows } = await db().query(
      "SELECT count(*) AS n FROM messages WHERE role = 'user' AND turn_id IS NULL",
    );
    if (rows[0].n === 0) return;
    await sleep(20);
  }
  throw new Error("drain timed out with messages still in the inbox");
}

export async function rows(ref: ThreadRef) {
  const { rows } = await db().query(
    `SELECT id, role, content, reply_to_id, turn_id FROM messages
     WHERE tenant_id = $1 AND thread_id = $2 ORDER BY id`,
    [ref.tenantId, ref.threadId],
  );
  return rows;
}

export async function turns(ref: ThreadRef) {
  const { rows } = await db().query(
    "SELECT id, transcript FROM turns WHERE tenant_id = $1 AND thread_id = $2 ORDER BY id",
    [ref.tenantId, ref.threadId],
  );
  return rows;
}
