import { createAnthropic } from "@ai-sdk/anthropic";
import { APICallError, generateText, isStepCount, LoadAPIKeyError, type ModelMessage } from "ai";
import { config } from "./config";
import { tx } from "./db";
import { loadInbox, type ThreadRef } from "./messages";
import { buildSystemPrompt, renderBatch } from "./prompt";
import { buildTools } from "./tools";
import { estimateTokens, loadWindow } from "./window";

export type ThreadJob = ThreadRef & {
  attempts: number;
  leaseOwner: string;
  userName: string;
  timeZone: string;
};

type Reply = { text: string; replyToId: number | null };

class LeaseLostError extends Error {}
class EmptyReplyError extends Error {}

// Models that accept the "default" server-side refusal fallback.
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

/**
 * Blocking tools alone isn't enough: the real model can then end the turn with
 * no text at all. This goes in the messages rather than the system prompt,
 * because changing the system prompt mid-turn would invalidate thinking blocks.
 */
const LAST_STEP_NOTE: ModelMessage = {
  role: "user",
  content: "[System note: no more tool calls are available this turn. Reply now with what you have.]",
};

/**
 * Thinking blocks are signed against the exact history that produced them, and
 * the rolling window changes that history every turn, so replaying them would
 * get the request rejected. They stay live inside a turn and are dropped here,
 * before the turn is stored.
 */
export function stripReasoning(messages: ModelMessage[]): ModelMessage[] {
  return messages.flatMap((message): ModelMessage[] => {
    if (message.role !== "assistant") return [message];
    if (typeof message.content === "string") return message.content ? [message] : [];
    const content = message.content.filter(
      (part) => part.type !== "reasoning" && !(part.type === "text" && !part.text),
    );
    return content.length ? [{ ...message, content }] : [];
  });
}

/** Runs one turn. Nothing is written until it has fully succeeded. */
async function runAgent(job: ThreadJob, seen: Set<number>, signal: AbortSignal) {
  const inbox = await loadInbox(job);
  if (!inbox.length) return;
  inbox.forEach((message) => seen.add(message.id));

  const batch = renderBatch(inbox, job.timeZone);
  const window = await loadWindow(job, config.historyTokenBudget - estimateTokens([batch]));
  // Messages added mid-turn, by the step they were added before.
  const injected = new Map<number, ModelMessage[]>();

  // A blank key in .env counts as set for the SDK, which would then call the API with it.
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new LoadAPIKeyError({ message: "ANTHROPIC_API_KEY is not set" });
  }
  const anthropic = createAnthropic();
  const result = await generateText({
    model: anthropic(config.model),
    instructions: buildSystemPrompt({
      userName: job.userName,
      timeZone: job.timeZone,
      now: new Date(),
      hasOlderHistory: window.hasOlderHistory,
    }),
    messages: [...window.messages, batch],
    tools: buildTools(job, job.timeZone, () => [...seen]),
    stopWhen: isStepCount(config.maxSteps),
    maxOutputTokens: 16_000,
    abortSignal: signal,
    providerOptions: {
      anthropic: {
        thinking: { type: "adaptive" },
        effort: config.effort,
        ...(FALLBACK_MODELS.has(config.model) && { fallbacks: "default" }),
      },
    },
    prepareStep: async ({ stepNumber, messages }) => {
      if (stepNumber === 0) return {};
      const added: ModelMessage[] = [];
      const arrived = (await loadInbox(job)).filter((message) => !seen.has(message.id));
      if (arrived.length) {
        arrived.forEach((message) => seen.add(message.id));
        added.push(renderBatch(arrived, job.timeZone));
      }
      const lastStep = stepNumber === config.maxSteps - 1;
      if (lastStep) added.push(LAST_STEP_NOTE);
      if (added.length) injected.set(stepNumber, added);
      return {
        ...(added.length && { messages: [...messages, ...added] }),
        ...(lastStep && { toolChoice: "none" as const }),
      };
    },
  });

  const replies = collectReplies(result.steps);
  if (!replies.length) throw new EmptyReplyError(`No reply, finish reason ${result.finishReason}`);

  const transcript = stripReasoning([
    batch,
    ...result.steps.flatMap((step, index) => [...(injected.get(index) ?? []), ...step.response.messages]),
  ]);
  await commitTurn(job, [...seen], transcript, replies, "assistant");
}

type StepLike = {
  text: string;
  toolResults: Array<{ toolName: string; input: unknown; output: unknown }>;
};

/**
 * Quoted replies in the order they were sent, then the final text. Text from
 * earlier steps is the model narrating its tool calls, so it isn't sent.
 */
function collectReplies(steps: StepLike[]): Reply[] {
  const replies: Reply[] = [];
  for (const step of steps) {
    for (const result of step.toolResults) {
      if (result.toolName !== "reply_to_message") continue;
      if (!(result.output as { sent?: boolean }).sent) continue;
      const input = result.input as { message_id: number; text: string };
      replies.push({ text: input.text, replyToId: input.message_id });
    }
  }
  const finalText = steps.at(-1)?.text.trim();
  if (finalText) replies.push({ text: finalText, replyToId: null });
  return replies;
}

/**
 * Writes a whole turn atomically. The lease check is the fence: a worker that
 * lost its lease mid-turn fails here and its result is discarded.
 */
async function commitTurn(
  job: ThreadJob,
  messageIds: number[],
  transcript: ModelMessage[],
  replies: Reply[],
  role: "assistant" | "system",
) {
  await tx(async (client) => {
    const fence = await client.query(
      `UPDATE threads SET attempts = 0, retry_at = NULL
       WHERE tenant_id = $1 AND id = $2 AND lease_owner = $3`,
      [job.tenantId, job.threadId, job.leaseOwner],
    );
    if (!fence.rowCount) throw new LeaseLostError();

    const { rows } = await client.query(
      `INSERT INTO turns (tenant_id, thread_id, transcript, token_estimate)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [job.tenantId, job.threadId, JSON.stringify(transcript), estimateTokens(transcript)],
    );
    const turnId = rows[0].id;
    await client.query(
      "UPDATE messages SET turn_id = $3 WHERE tenant_id = $1 AND thread_id = $2 AND id = ANY($4::bigint[])",
      [job.tenantId, job.threadId, turnId, messageIds],
    );
    for (const reply of replies) {
      await client.query(
        `INSERT INTO messages (tenant_id, thread_id, role, content, reply_to_id, turn_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [job.tenantId, job.threadId, role, reply.text, reply.replyToId, turnId],
      );
    }
  });
}

function isRetryable(error: unknown) {
  if (error instanceof EmptyReplyError || LoadAPIKeyError.isInstance(error)) return false;
  if (APICallError.isInstance(error)) return error.isRetryable;
  return true;
}

function failureNotice(error: unknown) {
  if (LoadAPIKeyError.isInstance(error)) {
    return "The agent can't reply yet because no model API key is configured. Your message is saved.";
  }
  return "The agent couldn't reply to this. Your message is saved. Send another message to try again.";
}

/**
 * After the final failed attempt the messages are closed out as a turn with a
 * note, so the model later knows they went unanswered and the thread can't get
 * stuck retrying forever.
 */
async function giveUp(job: ThreadJob, seen: Set<number>, error: unknown) {
  const inbox = (await loadInbox(job)).filter((message) => seen.has(message.id));
  if (!inbox.length) return;
  const transcript: ModelMessage[] = [
    renderBatch(inbox, job.timeZone),
    { role: "assistant", content: "[System note: these messages went unanswered because of an error.]" },
  ];
  await commitTurn(job, [...seen], transcript, [{ text: failureNotice(error), replyToId: null }], "system");
}

/** Runs a turn for a leased thread. Returns how long to wait before retrying, if at all. */
export async function processThread(job: ThreadJob, signal: AbortSignal): Promise<{ retryInMs?: number }> {
  const seen = new Set<number>();
  try {
    await runAgent(job, seen, signal);
    return {};
  } catch (error) {
    if (error instanceof LeaseLostError) throw error;
    console.error(`[turn] thread ${job.threadId} attempt ${job.attempts + 1} failed:`, error);
    if (isRetryable(error) && job.attempts + 1 < config.maxTurnAttempts) {
      return { retryInMs: config.retryBaseMs * 3 ** job.attempts };
    }
    await giveUp(job, seen, error);
    return {};
  }
}
