import { config } from "./config";
import { db, tx } from "./db";

/** Every core query takes this, so a query can't be written without a tenant. */
export type ThreadRef = { tenantId: number; threadId: number };

export type Message = {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: Date;
  clientId: string | null;
  replyTo: { id: number; role: "user" | "assistant"; content: string; createdAt: Date } | null;
};

export class InvalidMessageError extends Error {}

const SELECT_MESSAGE = `
  SELECT m.id, m.role, m.content, m.created_at, m.dedupe_key, m.reply_to_id,
         q.role AS q_role, q.content AS q_content, q.created_at AS q_created_at
  FROM messages m
  LEFT JOIN messages q
    ON q.tenant_id = m.tenant_id AND q.thread_id = m.thread_id AND q.id = m.reply_to_id`;

type Row = {
  id: number;
  role: Message["role"];
  content: string;
  created_at: Date;
  dedupe_key: string | null;
  reply_to_id: number | null;
  q_role: "user" | "assistant" | null;
  q_content: string | null;
  q_created_at: Date | null;
};

function toMessage(row: Row): Message {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    clientId: row.dedupe_key,
    replyTo: row.reply_to_id
      ? { id: row.reply_to_id, role: row.q_role!, content: row.q_content!, createdAt: row.q_created_at! }
      : null,
  };
}

export async function getOrCreateThread(tenantId: number, userId: number): Promise<ThreadRef> {
  await db().query(
    "INSERT INTO threads (tenant_id, user_id) VALUES ($1, $2) ON CONFLICT (tenant_id, user_id) DO NOTHING",
    [tenantId, userId],
  );
  const { rows } = await db().query("SELECT id FROM threads WHERE tenant_id = $1 AND user_id = $2", [
    tenantId,
    userId,
  ]);
  return { tenantId, threadId: rows[0].id };
}

/**
 * The single way into the core for any channel. It stores the message and
 * returns; the worker sees it in the inbox and takes it from there.
 * dedupeKey makes redelivery safe: the web client sends a generated id, and a
 * WhatsApp webhook would send the provider's message id.
 */
export async function receiveMessage(
  ref: ThreadRef,
  input: { text: string; dedupeKey: string; replyToId?: number | null },
): Promise<Message> {
  const text = input.text.trim();
  if (!text) throw new InvalidMessageError("Message is empty");
  if (text.length > config.maxMessageChars) throw new InvalidMessageError("Message is too long");

  return tx(async (client) => {
    // Holding the thread row while inserting makes ids commit in order per thread,
    // so a client polling "after id N" can never skip a message.
    await client.query("SELECT 1 FROM threads WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [
      ref.tenantId,
      ref.threadId,
    ]);
    if (input.replyToId != null) {
      const target = await client.query(
        `SELECT 1 FROM messages
         WHERE tenant_id = $1 AND thread_id = $2 AND id = $3 AND role IN ('user', 'assistant')`,
        [ref.tenantId, ref.threadId, input.replyToId],
      );
      if (!target.rowCount) throw new InvalidMessageError("Quoted message not found");
    }
    await client.query(
      `INSERT INTO messages (tenant_id, thread_id, role, content, dedupe_key, reply_to_id)
       VALUES ($1, $2, 'user', $3, $4, $5)
       ON CONFLICT (thread_id, dedupe_key) DO NOTHING`,
      [ref.tenantId, ref.threadId, text, input.dedupeKey, input.replyToId ?? null],
    );
    const { rows } = await client.query<Row>(
      `${SELECT_MESSAGE} WHERE m.tenant_id = $1 AND m.thread_id = $2 AND m.dedupe_key = $3`,
      [ref.tenantId, ref.threadId, input.dedupeKey],
    );
    return toMessage(rows[0]);
  });
}

/** Newest page by default. Pass beforeId to page back, afterId to fetch what's new. */
export async function listMessages(
  ref: ThreadRef,
  options: { beforeId?: number; afterId?: number; limit?: number } = {},
): Promise<Message[]> {
  const limit = Math.min(options.limit ?? 50, 200);
  const params = [ref.tenantId, ref.threadId, limit];
  const scope = "m.tenant_id = $1 AND m.thread_id = $2";
  if (options.afterId != null) {
    const { rows } = await db().query<Row>(
      `${SELECT_MESSAGE} WHERE ${scope} AND m.id > $4 ORDER BY m.id ASC LIMIT $3`,
      [...params, options.afterId],
    );
    return rows.map(toMessage);
  }
  const { rows } = await db().query<Row>(
    `${SELECT_MESSAGE} WHERE ${scope} AND m.id < $4 ORDER BY m.id DESC LIMIT $3`,
    [...params, options.beforeId ?? Number.MAX_SAFE_INTEGER],
  );
  return rows.map(toMessage).reverse();
}

/** User messages not yet part of a finished turn, oldest first. */
export async function loadInbox(ref: ThreadRef): Promise<Message[]> {
  const { rows } = await db().query<Row>(
    `${SELECT_MESSAGE}
     WHERE m.tenant_id = $1 AND m.thread_id = $2 AND m.role = 'user' AND m.turn_id IS NULL
     ORDER BY m.id ASC`,
    [ref.tenantId, ref.threadId],
  );
  return rows.map(toMessage);
}

export async function isAgentTyping(ref: ThreadRef): Promise<boolean> {
  const { rows } = await db().query(
    "SELECT lease_expires_at > now() AS typing FROM threads WHERE tenant_id = $1 AND id = $2",
    [ref.tenantId, ref.threadId],
  );
  return rows[0]?.typing === true;
}
