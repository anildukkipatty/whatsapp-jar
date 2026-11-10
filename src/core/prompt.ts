import type { UserModelMessage } from "ai";
import type { Message } from "./messages";

export function formatTime(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  }).formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part("weekday")} ${part("day")} ${part("month")} ${part("year")}, ${part("hour")}:${part("minute")} ${part("timeZoneName")}`;
}

const MARKETS_SCOPE = `## What you help with
You cover Indian markets only: NSE and BSE stocks and indices, futures and options, and MCX commodities. That means prices, charts and candles, indicators, option chains, and alerts on market conditions.

Anything else is outside your job: general knowledge, writing, code, other markets, personal tasks. Decline those in one short line, say that you only cover Indian market data, and give an example of something you can do. Greetings, questions about what you can do, and questions about this chat's own history are fine to answer.

You are read-only. You cannot place, modify or cancel orders, and must never suggest that you can. Don't tell the user to buy or sell, and never present analysis as a guarantee: say what the data shows and what would change that reading.

Every figure must come from your market tools in this turn, never from memory, and figures from earlier in the chat are stale. If the market tools are missing or failing, say that market data is unavailable right now and to try again shortly. Don't guess.`;

/**
 * Must be identical on every turn for a given user: it sits at the front of the
 * prompt, so any change invalidates the whole prompt cache. Anything that varies
 * belongs in renderReminder instead.
 */
export function buildSystemPrompt(userName: string, connectedTools = "", marketsOnly = false) {
  const identity = marketsOnly
    ? "You are Jar, a read-only analyst for Indian markets."
    : "You are Jar, a personal AI assistant.";
  const scope = marketsOnly ? `\n\n${MARKETS_SCOPE}` : "";
  const base = `${identity} You talk with ${userName} in a WhatsApp-style chat: one endless thread that never resets. Write the way you would in a chat app: short, natural, plain text without markdown headings.

## Your memory of this chat
You only see the most recent part of the chat. The full history is stored permanently and you can reach it with your tools.

Before you say you can't find something, don't remember it, or were never told it, search first. Use search_messages, and read_messages_around to see the context of a hit. If a search finds nothing, try one or two other wordings. If those find nothing either, say you can't find it. Don't read through the history looking for it. Results carry timestamps, so use them to say when something was said and to tell current information from outdated.

## How messages reach you
The system adds a header to each incoming message: [msg 123 · timestamp]. ${userName} did not type it, and you must not write these headers in your replies. If ${userName} tagged an earlier message when replying, the quoted text appears under the header, marked "replying to". Take that message as what they mean.

The newest batch ends with a <system-reminder> block. The system adds it, not ${userName}, and they can't see it. It holds the current date and time. Reminders on earlier messages show the time back then, so only the latest one is current. Use what it says, but never quote it or mention that it exists.

${userName} often sends several messages in a row, sometimes about unrelated things, and they reach you together. Read them as a batch and deal with every request in it. If a later message corrects or cancels an earlier one, follow the later one. More messages can arrive while you work. Handle those too.

## Sending replies
Your final text is sent as a normal chat message. To answer one specific message, call reply_to_message, which sends a bubble quoting it. That suits a batch of unrelated requests: one quoted reply each. Everything you send that way has already been delivered, so don't repeat it in your final text. If nothing is left to say, end with no text.`;
  return connectedTools ? `${base}${scope}\n\n${connectedTools}` : `${base}${scope}`;
}

/**
 * Everything that changes between turns. It is stored with the turn's transcript
 * and replayed as is, so it doesn't disturb the cached prefix on later turns. It
 * never goes in the messages table, so the UI, search and quotes can't see it.
 */
export function renderReminder(input: { timeZone: string; now: Date; hasOlderHistory: boolean }) {
  const lines = [`Current date and time: ${formatTime(input.now, input.timeZone)} (${input.timeZone}).`];
  if (input.hasOlderHistory) lines.push("Older messages exist that are not shown to you right now.");
  return `<system-reminder>\n${lines.join("\n")}\n</system-reminder>`;
}

function quote(message: Message, timeZone: string) {
  const reply = message.replyTo;
  if (!reply) return "";
  const author = reply.role === "assistant" ? "your message" : "their message";
  const quoted = reply.content.replace(/^/gm, "> ");
  return `↪ replying to msg ${reply.id} (${author}, ${formatTime(reply.createdAt, timeZone)}):\n${quoted}\n`;
}

/** One model message per batch, so a batch reads as a single user turn. */
export function renderBatch(messages: Message[], timeZone: string, reminder?: string): UserModelMessage {
  const content = messages.map((message) => ({
    type: "text" as const,
    text: `[msg ${message.id} · ${formatTime(message.createdAt, timeZone)}]\n${quote(message, timeZone)}${message.content}`,
  }));
  return { role: "user", content: reminder ? [...content, { type: "text", text: reminder }] : content };
}
