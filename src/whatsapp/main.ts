import { create } from "@open-wa/wa-automate";
import { startWorker } from "../core/worker";
import { waConfig } from "./config";
import { deliverPending, handleIncoming, type Sender } from "./gateway";

/**
 * The WhatsApp channel: one linked number, run as its own long-lived process.
 * All state is in Postgres, so when the session drops this process exits and
 * the supervisor (systemd, pm2) starts it again.
 */

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
if (!waConfig.open && !waConfig.allowedNumbers.size) {
  // Refusing to guess: on a personal number, "everyone" means all your contacts.
  throw new Error("Set WHATSAPP_ALLOWED_NUMBERS to the numbers Jar may answer, or WHATSAPP_OPEN=true to answer anyone");
}

const client = await create({
  sessionId: "jar",
  sessionDataPath: waConfig.sessionDir,
  headless: true,
  useChrome: true,
  qrTimeout: 0,
  authTimeout: 0,
});
console.log(
  waConfig.open
    ? "[whatsapp] connected, answering any number"
    : `[whatsapp] connected, answering only: ${[...waConfig.allowedNumbers].join(", ")}`,
);

const sender: Sender = {
  async send(chatId, text, quotedId) {
    type ChatId = Parameters<typeof client.reply>[0];
    type MessageId = Parameters<typeof client.reply>[2];
    const result = quotedId
      ? await client.reply(chatId as ChatId, text, quotedId as MessageId)
      : await client.sendText(chatId as ChatId, text);
    if (result === false) throw new Error("WhatsApp did not accept the message");
    return typeof result === "string" ? result : null;
  },
};

/** WhatsApp Web hands back a quoted message's id either as a string or as an object. */
function idOf(quoted: unknown): string | null {
  const id = (quoted as { id?: unknown } | undefined)?.id;
  if (typeof id === "string") return id;
  const serialized = (id as { _serialized?: unknown } | undefined)?._serialized;
  return typeof serialized === "string" ? serialized : null;
}

client.onMessage(async (message) => {
  try {
    await handleIncoming(
      {
        id: message.id,
        chatId: message.chatId ?? message.from,
        fromMe: message.fromMe,
        isGroup: message.isGroupMsg,
        type: message.type,
        text: message.body ?? "",
        senderName: message.sender?.pushname ?? message.notifyName,
        quotedId: idOf(message.quotedMsg) ?? idOf(message.quotedMsgObj),
      },
      sender,
    );
  } catch (error) {
    console.error("[whatsapp] handling a message failed:", error);
  }
});

// The turn worker runs here too, so this process works without the web server.
// Running both is fine: the thread lease decides who takes a turn.
startWorker();

const deliver = async () => {
  await deliverPending(sender).catch((error) => console.error("[whatsapp] delivery pass failed:", error));
  setTimeout(deliver, waConfig.deliveryPollMs);
};
void deliver();

let unhealthyChecks = 0;
setInterval(() => {
  const state = client.getState();
  unhealthyChecks = state === "DISCONNECTED" || state === "STOPPED" ? unhealthyChecks + 1 : 0;
  if (unhealthyChecks >= 2) {
    console.error(`[whatsapp] session is ${state}, exiting so the supervisor restarts it`);
    process.exit(1);
  }
}, 60_000);

client.onLogout(() => {
  console.error("[whatsapp] logged out by WhatsApp. Start again and scan the QR code to relink.");
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    client
      .stop(signal)
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}
