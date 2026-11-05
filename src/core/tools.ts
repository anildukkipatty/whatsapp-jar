import { tool } from "ai";
import { z } from "zod";
import { db } from "./db";
import type { ThreadRef } from "./messages";
import { formatTime } from "./prompt";
import { readAround, searchMessages, type Hit } from "./search";

/**
 * The thread comes from the turn, never from model input, so no tool argument
 * can reach another user or tenant.
 */
export function buildTools(ref: ThreadRef, timeZone: string, currentTurnIds: () => number[]) {
  const present = (hit: Hit) => ({
    id: hit.id,
    from: hit.role === "assistant" ? "you" : "user",
    at: formatTime(hit.createdAt, timeZone),
    text: hit.text,
  });

  return {
    search_messages: tool({
      description:
        "Search the full history of this chat, including messages too old for you to see. " +
        "Matches word stems, so plural and tense don't matter. Quote a phrase for an exact match. " +
        "Give a date range to narrow it, or a date range alone to see what was said in that period. " +
        "Results are the best matches with timestamps and message ids.",
      inputSchema: z.object({
        query: z.string().optional().describe("Keywords, or a quoted phrase"),
        after: z.string().optional().describe("Only messages at or after this ISO 8601 time"),
        before: z.string().optional().describe("Only messages before this ISO 8601 time"),
        limit: z.number().int().min(1).max(25).optional().describe("Default 10"),
      }),
      execute: async ({ query, after, before, limit }) => {
        const afterDate = after ? new Date(after) : undefined;
        const beforeDate = before ? new Date(before) : undefined;
        if ([afterDate, beforeDate].some((date) => date && Number.isNaN(date.getTime()))) {
          return { error: "after and before must be ISO 8601 times" };
        }
        if (!query?.trim() && !afterDate && !beforeDate) {
          return { error: "Give a query, a date range, or both" };
        }
        const { hits, matched } = await searchMessages(ref, {
          query,
          after: afterDate,
          before: beforeDate,
          limit: limit ?? 10,
          excludeIds: currentTurnIds(),
        });
        if (!hits.length) return { hits: [], note: "No matches. Try other wordings before giving up." };
        return { hits: hits.map(present), matched };
      },
    }),

    read_messages_around: tool({
      description:
        "Read a message from the chat history in full, with the messages before and after it. " +
        "Use it on a search hit to get the context.",
      inputSchema: z.object({
        message_id: z.number().int(),
        before: z.number().int().min(0).max(20).optional().describe("Messages before it. Default 5"),
        after: z.number().int().min(0).max(20).optional().describe("Messages after it. Default 5"),
      }),
      execute: async ({ message_id, before, after }) => {
        const messages = await readAround(ref, message_id, { before: before ?? 5, after: after ?? 5 });
        if (!messages) return { error: `Message ${message_id} not found in this chat` };
        return { messages: messages.map(present) };
      },
    }),

    reply_to_message: tool({
      description:
        "Send a chat message that quotes one specific earlier message, as a reply. It is delivered as its own bubble.",
      inputSchema: z.object({
        message_id: z.number().int().describe("The message to quote"),
        text: z.string().min(1).describe("Your reply"),
      }),
      execute: async ({ message_id }) => {
        const { rowCount } = await db().query(
          `SELECT 1 FROM messages
           WHERE tenant_id = $1 AND thread_id = $2 AND id = $3 AND role IN ('user', 'assistant')`,
          [ref.tenantId, ref.threadId, message_id],
        );
        // The reply itself is stored when the turn commits. See collectReplies in turn.ts.
        return rowCount ? { sent: true } : { error: `Message ${message_id} not found in this chat` };
      },
    }),
  };
}
