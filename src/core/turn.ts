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
  // Messages picked up mid-turn, by the step they were added before.
  const injected = new Map<number, ModelMessage>();

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
      // On the last allowed step, make the model answer instead of calling another tool.
      const lastStep = stepNumber === config.maxSteps - 1 ? { toolChoice: "none" as const } : {};
      if (stepNumber === 0) return lastStep;
      const arrived = (await loadInbox(job)).filter((message) => !seen.has(message.id));
      if (!arrived.length) return lastStep;
      arrived.forEach((message) => seen.add(message.id));
      const update = renderBatch(arrived, job.timeZone);
      injected.set(stepNumber, update);
      return { ...lastStep, messages: [...messages, update] };
    },
  });

  const replies = collectReplies(result.steps);
  if (!replies.length) throw new EmptyReplyError(`No reply, finish reason ${result.finishReason}`);

  const transcript = stripReasoning([
    batch,
    ...result.steps.flatMap((step, index) => {
      const update = injected.get(index);
      return update ? [update, ...step.response.messages] : step.response.messages;
    }),
  ]);
  await commitTurn(job, [...seen], transcript, replies, "assistant");
}

type StepLike = {
  text: string;
  toolResults: Array<{ toolName: string; input: unknown; output: unknown }>;
};

/** Each step's text and quoted replies, in the order the model produced them. */
function collectReplies(steps: StepLike[]): Reply[] {
  const replies: Reply[] = [];
  for (const step of steps) {
    if (step.text.trim()) replies.push({ text: step.text.trim(), replyToId: null });
    for (const result of step.toolResults) {
      if (result.toolName !== "reply_to_message") continue;
      if (!(result.output as { sent?: boolean }).sent) continue;
      const input = result.input as { message_id: number; text: string };
      replies.push({ text: input.text, replyToId: input.message_id });
    }
  }
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
