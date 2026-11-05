import type { ModelMessage } from "ai";
import { db } from "./db";
import type { ThreadRef } from "./messages";

/**
 * Rough and deliberately high. Three characters per token overestimates plain
 * English, which leaves room for tokenizers that use more on code or other
 * languages. Serialized JSON counts tool calls and results too.
 */
export function estimateTokens(messages: ModelMessage[]) {
  return Math.ceil(JSON.stringify(messages).length / 3);
}

/**
 * The newest whole turns that fit the budget, oldest first. Stops at the first
 * turn that doesn't fit, so the window never has a gap in it.
 */
export async function loadWindow(ref: ThreadRef, tokenBudget: number) {
  const { rows } = await db().query(
    `SELECT transcript FROM (
       SELECT id, transcript, sum(token_estimate) OVER (ORDER BY id DESC) AS running
       FROM turns WHERE tenant_id = $1 AND thread_id = $2
     ) recent
     WHERE running <= $3
     ORDER BY id ASC`,
    [ref.tenantId, ref.threadId, tokenBudget],
  );
  const { rows: count } = await db().query(
    "SELECT count(*) AS total FROM turns WHERE tenant_id = $1 AND thread_id = $2",
    [ref.tenantId, ref.threadId],
  );
  return {
    messages: rows.flatMap((row) => row.transcript as ModelMessage[]),
    hasOlderHistory: rows.length < count[0].total,
  };
}
