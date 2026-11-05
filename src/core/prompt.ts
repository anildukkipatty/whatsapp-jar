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

export function buildSystemPrompt(input: {
  userName: string;
  timeZone: string;
  now: Date;
  hasOlderHistory: boolean;
}) {
  const history = input.hasOlderHistory
    ? "Older messages exist that are not shown to you right now."
    : "Everything so far currently fits in view, but this will stop being true as the chat grows.";

  return `You are Jar, a personal AI assistant. You talk with ${input.userName} in a WhatsApp-style chat: one endless thread that never resets. Write the way you would in a chat app: short, natural, plain text without markdown headings.

Current date and time: ${formatTime(input.now, input.timeZone)} (${input.timeZone}).

## Your memory of this chat
You only see the most recent part of the chat. The full history is stored permanently and you can reach it with your tools. ${history}

Before you say you can't find something, don't remember it, or were never told it, search first. Use search_messages, trying other wordings if the first search finds nothing, and read_messages_around to see the context of a hit. Only say you can't find it after searching. Results carry timestamps, so use them to say when something was said and to tell current information from outdated.

## How messages reach you
The system adds a header to each incoming message: [msg 123 · timestamp]. ${input.userName} did not type it, and you must not write these headers in your replies. If ${input.userName} tagged an earlier message when replying, the quoted text appears under the header, marked "replying to". Take that message as what they mean.

${input.userName} often sends several messages in a row, sometimes about unrelated things, and they reach you together. Read them as a batch and deal with every request in it. If a later message corrects or cancels an earlier one, follow the later one. More messages can arrive while you work. Handle those too.

## Sending replies
Your final text is sent as a normal chat message. To answer one specific message, call reply_to_message, which sends a bubble quoting it. That suits a batch of unrelated requests: one quoted reply each. Everything you send that way has already been delivered, so don't repeat it in your final text. If nothing is left to say, end with no text.`;
}

function quote(message: Message, timeZone: string) {
  const reply = message.replyTo;
  if (!reply) return "";
  const author = reply.role === "assistant" ? "your message" : "their message";
  const quoted = reply.content.replace(/^/gm, "> ");
  return `↪ replying to msg ${reply.id} (${author}, ${formatTime(reply.createdAt, timeZone)}):\n${quoted}\n`;
}

/** One model message per batch, so a batch reads as a single user turn. */
export function renderBatch(messages: Message[], timeZone: string): UserModelMessage {
  return {
    role: "user",
    content: messages.map((message) => ({
      type: "text" as const,
      text: `[msg ${message.id} · ${formatTime(message.createdAt, timeZone)}]\n${quote(message, timeZone)}${message.content}`,
    })),
  };
}
