import { db } from "./db";
import type { ThreadRef } from "./messages";

export type Hit = { id: number; role: "user" | "assistant"; createdAt: Date; text: string };

const MAX_MESSAGE_CHARS = 4_000;
/** Hits up to this long are returned whole. Longer ones become a snippet around the match. */
const WHOLE_MESSAGE_CHARS = 500;

/**
 * Full-text search over one thread. Matches stemmed words, so "flights" finds
 * "flight". Tries all words first, then falls back to any word ranked by
 * relevance. With no query it just browses the date range, newest first.
 */
export async function searchMessages(
  ref: ThreadRef,
  options: { query?: string; after?: Date; before?: Date; limit: number; excludeIds: number[] },
): Promise<{ hits: Hit[]; matched: "all-words" | "any-word" | "date-range" }> {
  const scope = [
    ref.tenantId,
    ref.threadId,
    options.after ?? null,
    options.before ?? null,
    options.excludeIds,
    options.limit,
  ];
  const where = `
    m.tenant_id = $1 AND m.thread_id = $2 AND m.role IN ('user', 'assistant')
    AND ($3::timestamptz IS NULL OR m.created_at >= $3)
    AND ($4::timestamptz IS NULL OR m.created_at < $4)
    AND m.id <> ALL($5::bigint[])`;

  if (!options.query?.trim()) {
    const { rows } = await db().query(
      `SELECT m.id, m.role, m.created_at, left(m.content, 300) AS text
       FROM messages m WHERE ${where} ORDER BY m.id DESC LIMIT $6`,
      scope,
    );
    return { hits: rows.map(toHit), matched: "date-range" };
  }

  const run = async (tsquery: string) => {
    const { rows } = await db().query(
      `WITH hits AS (
         SELECT m.id, m.role, m.created_at, m.content, ts_rank_cd(m.search, q) AS rank, q
         FROM messages m, (SELECT ${tsquery} AS q) query
         WHERE ${where} AND m.search @@ q
         ORDER BY rank DESC, m.id DESC
         LIMIT $6
       )
       SELECT id, role, created_at,
              ts_headline('english', content, q,
                          'StartSel=**, StopSel=**, MaxWords=60, MinWords=30, HighlightAll='
                          || (length(content) <= ${WHOLE_MESSAGE_CHARS})::text) AS text
       FROM hits ORDER BY rank DESC, id DESC`,
      [...scope, options.query],
    );
    return rows.map(toHit);
  };

  const allWords = await run("websearch_to_tsquery('english', $7)");
  if (allWords.length) return { hits: allWords, matched: "all-words" };
  const anyWord = await run("replace(websearch_to_tsquery('english', $7)::text, ' & ', ' | ')::tsquery");
  return { hits: anyWord, matched: "any-word" };
}

/** The message itself plus its neighbours, in chat order. Null if not in this thread. */
export async function readAround(
  ref: ThreadRef,
  messageId: number,
  options: { before: number; after: number },
): Promise<Hit[] | null> {
  const { rows } = await db().query(
    `WITH thread AS (
       SELECT id, role, created_at, content FROM messages
       WHERE tenant_id = $1 AND thread_id = $2 AND role IN ('user', 'assistant')
     )
     SELECT id, role, created_at, left(content, ${MAX_MESSAGE_CHARS}) AS text FROM (
       (SELECT * FROM thread WHERE id = $3)
       UNION ALL (SELECT * FROM thread WHERE id < $3 ORDER BY id DESC LIMIT $4)
       UNION ALL (SELECT * FROM thread WHERE id > $3 ORDER BY id ASC LIMIT $5)
     ) around
     WHERE EXISTS (SELECT 1 FROM thread WHERE id = $3)
     ORDER BY id`,
    [ref.tenantId, ref.threadId, messageId, options.before, options.after],
  );
  return rows.length ? rows.map(toHit) : null;
}

function toHit(row: { id: number; role: Hit["role"]; created_at: Date; text: string }): Hit {
  return { id: row.id, role: row.role, createdAt: row.created_at, text: row.text };
}
