import { db } from "../core/db";
import { getOrCreateThread, InvalidMessageError, receiveMessage, type ThreadRef } from "../core/messages";
import { waConfig } from "./config";

/** What the gateway needs from a WhatsApp message, whichever library produced it. */
export type Incoming = {
  id: string;
  chatId: string;
  fromMe: boolean;
  isGroup: boolean;
  /** WhatsApp's message type. "chat" is plain text. */
  type: string;
  text: string;
  senderName?: string | null;
  /** WhatsApp id of the message this one quotes, if any. */
  quotedId?: string | null;
};

export interface Sender {
  /** Sends a text and returns its WhatsApp id when known. Throws if it could not be sent. */
  send(chatId: string, text: string, quotedId?: string | null): Promise<string | null>;
}

export type Outcome = "accepted" | "ignored" | "not_text" | "limited" | "rejected";

const MEDIA_TYPES = new Set([
  "image",
  "video",
  "audio",
  "ptt",
  "document",
  "sticker",
  "album",
  "location",
  "vcard",
  "multi_vcard",
]);

export const NOTICES = {
  textOnly: "I can only read text messages for now. Please type your message.",
  tooLong: "That message is too long for me to read. Please send it in smaller parts.",
  userLimit:
    "You've reached today's limit for chatting with Jar. It resets at midnight. This message wasn't saved, so please send it again tomorrow.",
  globalLimit: "Jar has reached its capacity for today. Please try again tomorrow.",
};

const TEXT_ONLY_NOTICE_GAP_MS = 60_000;
const lastTextOnlyNotice = new Map<string, number>();
const loggedIgnored = new Set<string>();

/** One-to-one chats only: no groups, status broadcasts or channels. */
const isDirectChat = (chatId: string) => chatId.endsWith("@c.us") || chatId.endsWith("@lid");

function isAllowed(chatId: string) {
  if (waConfig.open) return true;
  const allowed = waConfig.allowedNumbers;
  return allowed.has(chatId) || allowed.has(chatId.split("@")[0]);
}

/** The name goes into the system prompt, so it is kept short and on one line. */
function cleanName(name?: string | null) {
  const cleaned = (name ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  return cleaned || "there";
}

async function getOrCreateUser(chatId: string, name?: string | null) {
  const tenant = await db().query(
    `WITH found AS (SELECT id FROM tenants WHERE name = $1 ORDER BY id LIMIT 1),
          made AS (INSERT INTO tenants (name) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM found) RETURNING id)
     SELECT id FROM found UNION ALL SELECT id FROM made`,
    [waConfig.tenantName],
  );
  // The no-op update makes RETURNING give the existing row. The name set at
  // first contact is kept, because changing it would rewrite the prompt cache.
  const { rows } = await db().query(
    `INSERT INTO users (tenant_id, name, timezone, whatsapp_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (whatsapp_id) DO UPDATE SET whatsapp_id = EXCLUDED.whatsapp_id
     RETURNING tenant_id, id`,
    [tenant.rows[0].id, cleanName(name), waConfig.timeZone, chatId],
  );
  return { tenantId: rows[0].tenant_id as number, userId: rows[0].id as number };
}

// Start of the current day in the WhatsApp time zone, as a timestamptz.
const DAY_START = "(date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1)";

/**
 * Message counts come from stored user messages and spend from the cost already
 * recorded on turns, so there is no separate counter to drift. Spend is only
 * known once a turn finishes, so the dollar limit can overshoot by one turn.
 */
async function limitReached(ref: ThreadRef): Promise<"user" | "global" | null> {
  const { rows } = await db().query(
    `SELECT
       (SELECT count(*) FROM messages
        WHERE tenant_id = $2 AND thread_id = $3 AND role = 'user' AND created_at >= ${DAY_START}) AS user_messages,
       (SELECT coalesce(sum(cost_usd), 0)::float8 FROM turns
        WHERE tenant_id = $2 AND thread_id = $3 AND created_at >= ${DAY_START}) AS user_usd,
       (SELECT count(*) FROM messages
        WHERE tenant_id = $2 AND role = 'user' AND created_at >= ${DAY_START}) AS all_messages,
       (SELECT coalesce(sum(cost_usd), 0)::float8 FROM turns
        WHERE tenant_id = $2 AND created_at >= ${DAY_START}) AS all_usd`,
    [waConfig.timeZone, ref.tenantId, ref.threadId],
  );
  const used = rows[0];
  const over = (value: number, limit: number) => limit > 0 && value >= limit;
  if (over(used.user_messages, waConfig.dailyMessages) || over(used.user_usd, waConfig.dailyUsd)) return "user";
  if (over(used.all_messages, waConfig.globalDailyMessages) || over(used.all_usd, waConfig.globalDailyUsd)) {
    return "global";
  }
  return null;
}

/** True the first time it is called for a user each day. */
async function claimLimitNotice(tenantId: number, userId: number) {
  const { rowCount } = await db().query(
    `UPDATE users SET limit_notice_at = now()
     WHERE tenant_id = $2 AND id = $3 AND (limit_notice_at IS NULL OR limit_notice_at < ${DAY_START})`,
    [waConfig.timeZone, tenantId, userId],
  );
  return rowCount === 1;
}

async function findQuoted(ref: ThreadRef, quotedId: string): Promise<number | null> {
  const { rows } = await db().query(
    `SELECT id FROM messages
     WHERE tenant_id = $1 AND thread_id = $2 AND role IN ('user', 'assistant')
       AND ((role = 'user' AND dedupe_key = $3) OR (role = 'assistant' AND external_id = $3))
     LIMIT 1`,
    [ref.tenantId, ref.threadId, quotedId],
  );
  return rows[0]?.id ?? null;
}

/** Notices are best effort: a failed one must not stop the message being handled. */
async function notify(sender: Sender, chatId: string, text: string, quotedId?: string) {
  await sender.send(chatId, text, quotedId).catch((error) => console.error("[whatsapp] notice failed:", error));
}

/**
 * Takes one message from WhatsApp. Like the web route, it only stores the
 * message: the worker answers it and deliverPending sends the answer.
 */
export async function handleIncoming(message: Incoming, sender: Sender): Promise<Outcome> {
  if (message.fromMe || message.isGroup || !isDirectChat(message.chatId)) return "ignored";
  if (!isAllowed(message.chatId)) {
    if (!loggedIgnored.has(message.chatId)) {
      loggedIgnored.add(message.chatId);
      console.log(`[whatsapp] ignoring ${message.chatId}: not in WHATSAPP_ALLOWED_NUMBERS`);
    }
    return "ignored";
  }

  if (message.type !== "chat") {
    if (!MEDIA_TYPES.has(message.type)) return "ignored";
    const last = lastTextOnlyNotice.get(message.chatId) ?? 0;
    if (Date.now() - last > TEXT_ONLY_NOTICE_GAP_MS) {
      lastTextOnlyNotice.set(message.chatId, Date.now());
      await notify(sender, message.chatId, NOTICES.textOnly);
    }
    return "not_text";
  }
  if (!message.text.trim()) return "ignored";

  const user = await getOrCreateUser(message.chatId, message.senderName);
  const ref = await getOrCreateThread(user.tenantId, user.userId);

  const limit = await limitReached(ref);
  if (limit) {
    if (await claimLimitNotice(user.tenantId, user.userId)) {
      await notify(sender, message.chatId, limit === "user" ? NOTICES.userLimit : NOTICES.globalLimit);
    }
    return "limited";
  }

  const replyToId = message.quotedId ? await findQuoted(ref, message.quotedId) : null;
  try {
    await receiveMessage(ref, { text: message.text, dedupeKey: message.id, replyToId });
    return "accepted";
  } catch (error) {
    if (!(error instanceof InvalidMessageError)) throw error;
    await notify(sender, message.chatId, NOTICES.tooLong, message.id);
    return "rejected";
  }
}

/**
 * Sends replies that are waiting, oldest first. A failed send stops that thread
 * for this pass so its replies stay in order, and is retried on the next pass.
 *
 * Delivery is at least once: if the process dies between sending and recording
 * it, that reply is sent again. Run only one WhatsApp process per number.
 */
export async function deliverPending(sender: Sender): Promise<number> {
  const { rows } = await db().query(
    `SELECT m.id, m.tenant_id, m.thread_id, m.content, m.delivery_attempts, u.whatsapp_id,
            CASE q.role WHEN 'user' THEN q.dedupe_key ELSE q.external_id END AS quoted_id
     FROM messages m
     JOIN threads t ON t.tenant_id = m.tenant_id AND t.id = m.thread_id
     JOIN users u ON u.tenant_id = t.tenant_id AND u.id = t.user_id
     LEFT JOIN messages q
       ON q.tenant_id = m.tenant_id AND q.thread_id = m.thread_id AND q.id = m.reply_to_id
     WHERE u.whatsapp_id IS NOT NULL AND m.role IN ('assistant', 'system')
       AND m.delivered_at IS NULL AND m.delivery_attempts < $1
     ORDER BY m.id
     LIMIT 50`,
    [waConfig.maxDeliveryAttempts],
  );

  let sent = 0;
  const failedThreads = new Set<number>();
  for (const row of rows) {
    if (failedThreads.has(row.thread_id)) continue;
    try {
      const externalId = await sender.send(row.whatsapp_id, row.content, row.quoted_id);
      await db().query(
        "UPDATE messages SET delivered_at = now(), external_id = $3 WHERE tenant_id = $1 AND id = $2",
        [row.tenant_id, row.id, externalId],
      );
      sent++;
    } catch (error) {
      failedThreads.add(row.thread_id);
      const attempts = row.delivery_attempts + 1;
      const gaveUp = attempts >= waConfig.maxDeliveryAttempts ? ", giving up" : "";
      console.error(`[whatsapp] sending message ${row.id} failed (attempt ${attempts}${gaveUp}):`, error);
      await db().query("UPDATE messages SET delivery_attempts = $3 WHERE tenant_id = $1 AND id = $2", [
        row.tenant_id,
        row.id,
        attempts,
      ]);
    }
  }
  return sent;
}
