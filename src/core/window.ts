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

/** When the window is full, trim down to this share of the budget in one jump. */
const TRIM_TO = 0.5;

type TurnSize = { id: number; tokens: number };

/**
 * Index of the first turn to keep, or turns.length to keep none. Everything
 * stays until the budget is exceeded. Trimming a little every turn would change
 * the prompt prefix every turn and the cache would never be read.
 */
export function pickWindowStart(turns: TurnSize[], batchTokens: number, budget: number) {
  const total = turns.reduce((sum, turn) => sum + turn.tokens, batchTokens);
  if (total <= budget) return 0;
  let kept = batchTokens;
  let start = turns.length;
  while (start > 0 && kept + turns[start - 1].tokens <= budget * TRIM_TO) {
    start--;
    kept += turns[start].tokens;
  }
  return start;
}

/**
 * The whole turns the model sees this turn, oldest first. Stored transcripts are
 * replayed unchanged so the prompt prefix stays byte-identical between turns.
 */
export async function loadWindow(ref: ThreadRef, batchTokens: number, budget: number) {
  const { rows: thread } = await db().query(
    "SELECT window_start_turn_id AS start FROM threads WHERE tenant_id = $1 AND id = $2",
    [ref.tenantId, ref.threadId],
  );
  let startId: number = thread[0].start ?? 0;
  const { rows: sizes } = await db().query(
    `SELECT id, token_estimate AS tokens FROM turns
     WHERE tenant_id = $1 AND thread_id = $2 AND id >= $3 ORDER BY id`,
    [ref.tenantId, ref.threadId, startId],
  );

  const index = pickWindowStart(sizes, batchTokens, budget);
  if (index > 0) {
    startId = sizes[index]?.id ?? sizes[index - 1].id + 1;
    await db().query("UPDATE threads SET window_start_turn_id = $3 WHERE tenant_id = $1 AND id = $2", [
      ref.tenantId,
      ref.threadId,
      startId,
    ]);
  }

  const { rows } = await db().query(
    `SELECT transcript FROM turns
     WHERE tenant_id = $1 AND thread_id = $2 AND id >= $3 ORDER BY id`,
    [ref.tenantId, ref.threadId, startId],
  );
  const { rows: older } = await db().query(
    "SELECT EXISTS (SELECT 1 FROM turns WHERE tenant_id = $1 AND thread_id = $2 AND id < $3) AS older",
    [ref.tenantId, ref.threadId, startId],
  );
  return { turns: rows.map((row) => row.transcript as ModelMessage[]), hasOlderHistory: older[0].older as boolean };
}
