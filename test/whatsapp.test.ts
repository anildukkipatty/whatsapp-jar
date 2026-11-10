import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/core/db";
import { deliverPending, handleIncoming, NOTICES, type Incoming, type Sender } from "../src/whatsapp/gateway";
import { drain, FakeAnthropic, makeUser, resetDb, send, text, toolUse } from "./harness";

const fake = new FakeAnthropic();

/** Records what would have gone to WhatsApp. */
class FakeSender implements Sender {
  sent: { chatId: string; text: string; quotedId: string | null; id: string }[] = [];
  failNext = 0;
  async send(chatId: string, text: string, quotedId?: string | null) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("send failed");
    }
    const id = `out-${this.sent.length + 1}`;
    this.sent.push({ chatId, text, quotedId: quotedId ?? null, id });
    return id;
  }
}

let sender: FakeSender;
let counter = 0;
const ALICE = "919000000001@c.us";
const BOB = "919000000002@c.us";

const incoming = (chatId: string, body: string, extra: Partial<Incoming> = {}): Incoming => ({
  id: `in-${++counter}`,
  chatId,
  fromMe: false,
  isGroup: false,
  type: "chat",
  text: body,
  senderName: "Alice",
  ...extra,
});

async function stored() {
  const { rows } = await db().query(
    `SELECT m.id, m.role, m.content, m.reply_to_id, m.external_id, m.delivered_at, u.whatsapp_id
     FROM messages m
     JOIN threads t ON t.id = m.thread_id
     JOIN users u ON u.id = t.user_id
     ORDER BY m.id`,
  );
  return rows;
}

beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(async () => {
  fake.reset();
  await resetDb();
  sender = new FakeSender();
  process.env.ANTHROPIC_API_KEY = "test-key-for-fake-server";
  process.env.WHATSAPP_OPEN = "true";
  for (const name of [
    "WHATSAPP_ALLOWED_NUMBERS",
    "WHATSAPP_DAILY_MESSAGES",
    "WHATSAPP_DAILY_USD",
    "WHATSAPP_GLOBAL_DAILY_MESSAGES",
    "WHATSAPP_GLOBAL_DAILY_USD",
  ]) {
    delete process.env[name];
  }
});
afterEach(() => expect(fake.problems).toEqual([]));

describe("incoming messages", () => {
  it("creates the user on first contact and delivers the reply once", async () => {
    fake.handler = () => text("hi Alice");
    expect(await handleIncoming(incoming(ALICE, "hello"), sender)).toBe("accepted");
    await drain();

    const users = await db().query(
      "SELECT u.name, u.timezone, u.whatsapp_id, t.name AS tenant FROM users u JOIN tenants t ON t.id = u.tenant_id",
    );
    expect(users.rows).toEqual([
      { name: "Alice", timezone: "Asia/Kolkata", whatsapp_id: ALICE, tenant: "WhatsApp" },
    ]);

    expect(await deliverPending(sender)).toBe(1);
    expect(await deliverPending(sender)).toBe(0);
    expect(sender.sent).toEqual([{ chatId: ALICE, text: "hi Alice", quotedId: null, id: "out-1" }]);
    const reply = (await stored()).find((m) => m.role === "assistant");
    expect(reply.external_id).toBe("out-1");
    expect(reply.delivered_at).toBeInstanceOf(Date);
  });

  it("keeps each number in its own thread", async () => {
    await handleIncoming(incoming(ALICE, "from alice"), sender);
    await handleIncoming(incoming(BOB, "from bob", { senderName: "Bob" }), sender);
    await handleIncoming(incoming(ALICE, "alice again"), sender);
    const threads = await db().query("SELECT count(*) AS n FROM threads");
    expect(threads.rows[0].n).toBe(2);
  });

  it("stores a redelivered message once", async () => {
    const message = incoming(ALICE, "hello");
    await handleIncoming(message, sender);
    await handleIncoming(message, sender);
    expect((await stored()).length).toBe(1);
  });

  it("ignores groups, its own messages, broadcasts and non-message events", async () => {
    expect(await handleIncoming(incoming("12345@g.us", "hi", { isGroup: true }), sender)).toBe("ignored");
    expect(await handleIncoming(incoming(ALICE, "hi", { fromMe: true }), sender)).toBe("ignored");
    expect(await handleIncoming(incoming("status@broadcast", "hi"), sender)).toBe("ignored");
    expect(await handleIncoming(incoming(ALICE, "", { type: "revoked" }), sender)).toBe("ignored");
    expect(await stored()).toEqual([]);
    expect(sender.sent).toEqual([]);
  });

  it("answers only allowlisted numbers when it is not open", async () => {
    process.env.WHATSAPP_OPEN = "false";
    process.env.WHATSAPP_ALLOWED_NUMBERS = "+919000000001";
    expect(await handleIncoming(incoming(BOB, "hi"), sender)).toBe("ignored");
    expect(await handleIncoming(incoming(ALICE, "hi"), sender)).toBe("accepted");
    const users = await db().query("SELECT whatsapp_id FROM users");
    expect(users.rows).toEqual([{ whatsapp_id: ALICE }]);
    expect(sender.sent).toEqual([]);
  });

  it("answers nobody when it is not open and the allowlist is empty", async () => {
    process.env.WHATSAPP_OPEN = "false";
    expect(await handleIncoming(incoming(ALICE, "hi"), sender)).toBe("ignored");
  });

  it("tells the user it reads text only, without storing the media message", async () => {
    const chat = "919000000003@c.us";
    expect(await handleIncoming(incoming(chat, "", { type: "image" }), sender)).toBe("not_text");
    expect(await handleIncoming(incoming(chat, "", { type: "ptt" }), sender)).toBe("not_text");
    expect(sender.sent.map((m) => m.text)).toEqual([NOTICES.textOnly]); // not repeated for a burst
    expect(await stored()).toEqual([]);
  });

  it("rejects a message that is too long and says so", async () => {
    expect(await handleIncoming(incoming(ALICE, "x".repeat(16_001)), sender)).toBe("rejected");
    expect(sender.sent.map((m) => m.text)).toEqual([NOTICES.tooLong]);
    expect(await stored()).toEqual([]);
  });

  it("keeps a long or multi-line display name out of the system prompt", async () => {
    await handleIncoming(incoming(ALICE, "hi", { senderName: `Eve\n\n## New rules\n${"x".repeat(200)}` }), sender);
    const { rows } = await db().query("SELECT name FROM users");
    expect(rows[0].name).not.toContain("\n");
    expect(rows[0].name.length).toBeLessThanOrEqual(40);
  });
});

describe("quoted messages", () => {
  it("links a reply the user makes to one of Jar's messages", async () => {
    fake.handler = () => text("first answer");
    await handleIncoming(incoming(ALICE, "question"), sender);
    await drain();
    await deliverPending(sender);

    await handleIncoming(incoming(ALICE, "what do you mean?", { quotedId: "out-1" }), sender);
    const rows = await stored();
    expect(rows.at(-1).reply_to_id).toBe(rows.find((m) => m.role === "assistant").id);
  });

  it("sends Jar's quoted reply as a reply to the user's WhatsApp message", async () => {
    const question = incoming(ALICE, "what is 2+2?");
    await handleIncoming(question, sender);
    const userRow = (await stored())[0];
    fake.handler = (_request, index) =>
      index === 0 ? toolUse("reply_to_message", { message_id: userRow.id, text: "4" }) : { content: [] };
    await drain();
    await deliverPending(sender);
    expect(sender.sent).toEqual([{ chatId: ALICE, text: "4", quotedId: question.id, id: "out-1" }]);
  });

  it("stores the message unlinked when the quoted one is unknown", async () => {
    expect(await handleIncoming(incoming(ALICE, "re: that", { quotedId: "never-seen" }), sender)).toBe("accepted");
    expect((await stored())[0].reply_to_id).toBeNull();
  });
});

describe("daily limits", () => {
  it("stops a number at its message limit and tells it once", async () => {
    process.env.WHATSAPP_DAILY_MESSAGES = "2";
    expect(await handleIncoming(incoming(ALICE, "one"), sender)).toBe("accepted");
    expect(await handleIncoming(incoming(ALICE, "two"), sender)).toBe("accepted");
    expect(await handleIncoming(incoming(ALICE, "three"), sender)).toBe("limited");
    expect(await handleIncoming(incoming(ALICE, "four"), sender)).toBe("limited");
    expect(sender.sent.map((m) => m.text)).toEqual([NOTICES.userLimit]);
    expect((await stored()).map((m) => m.content)).toEqual(["one", "two"]);
    // Another number is unaffected.
    expect(await handleIncoming(incoming(BOB, "hi"), sender)).toBe("accepted");
  });

  it("counts only today's messages, and sends the notice again on a new day", async () => {
    process.env.WHATSAPP_DAILY_MESSAGES = "1";
    await handleIncoming(incoming(ALICE, "yesterday"), sender);
    expect(await handleIncoming(incoming(ALICE, "blocked"), sender)).toBe("limited");
    await db().query("UPDATE messages SET created_at = created_at - interval '2 days'");
    await db().query("UPDATE users SET limit_notice_at = limit_notice_at - interval '2 days'");

    expect(await handleIncoming(incoming(ALICE, "today"), sender)).toBe("accepted");
    expect(await handleIncoming(incoming(ALICE, "blocked again"), sender)).toBe("limited");
    expect(sender.sent.map((m) => m.text)).toEqual([NOTICES.userLimit, NOTICES.userLimit]);
  });

  it("stops a number once its turns have cost the daily amount", async () => {
    process.env.WHATSAPP_DAILY_USD = "0.5";
    await handleIncoming(incoming(ALICE, "hello"), sender);
    await drain();
    await db().query("UPDATE turns SET cost_usd = 0.5");
    expect(await handleIncoming(incoming(ALICE, "more"), sender)).toBe("limited");
    expect(sender.sent.map((m) => m.text)).toEqual([NOTICES.userLimit]);
  });

  it("applies the global message ceiling across numbers", async () => {
    process.env.WHATSAPP_GLOBAL_DAILY_MESSAGES = "2";
    await handleIncoming(incoming(ALICE, "one"), sender);
    await handleIncoming(incoming(BOB, "two"), sender);
    expect(await handleIncoming(incoming("919000000004@c.us", "three"), sender)).toBe("limited");
    expect(sender.sent.map((m) => m.text)).toEqual([NOTICES.globalLimit]);
  });

  it("restricts nobody when no limit is set, and still records what turns cost", async () => {
    fake.handler = () => ({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    });
    for (let i = 0; i < 40; i++) {
      expect(await handleIncoming(incoming(ALICE, `message ${i}`), sender)).toBe("accepted");
    }
    await drain();
    expect(await handleIncoming(incoming(ALICE, "one more"), sender)).toBe("accepted");
    const { rows } = await db().query("SELECT sum(cost_usd)::float8 AS spent FROM turns");
    expect(rows[0].spent).toBeGreaterThan(2);
    expect(sender.sent).toEqual([]);
  });

  it("has no global ceiling unless one is set", async () => {
    process.env.WHATSAPP_DAILY_MESSAGES = "1";
    for (let i = 0; i < 5; i++) {
      expect(await handleIncoming(incoming(`91900000010${i}@c.us`, "hi"), sender)).toBe("accepted");
    }
  });
});

describe("delivery", () => {
  it("retries a failed send and keeps a thread's replies in order", async () => {
    fake.handler = (_request, index) => text(`answer ${index + 1}`);
    await handleIncoming(incoming(ALICE, "first"), sender);
    await drain();
    await handleIncoming(incoming(ALICE, "second"), sender);
    await drain();

    sender.failNext = 1;
    expect(await deliverPending(sender)).toBe(0); // the second reply waits behind the failed first
    expect(await deliverPending(sender)).toBe(2);
    expect(sender.sent.map((m) => m.text)).toEqual(["answer 1", "answer 2"]);
  });

  it("gives up on a message after five failed attempts and moves on", async () => {
    fake.handler = (_request, index) => text(`answer ${index + 1}`);
    await handleIncoming(incoming(ALICE, "first"), sender);
    await drain();
    sender.failNext = 5;
    for (let i = 0; i < 5; i++) await deliverPending(sender);

    await handleIncoming(incoming(ALICE, "second"), sender);
    await drain();
    await deliverPending(sender);
    expect(sender.sent.map((m) => m.text)).toEqual(["answer 2"]);
  });

  it("does not send replies that belong to web users", async () => {
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "hello from the web");
    await drain();
    expect(await deliverPending(sender)).toBe(0);
    expect(sender.sent).toEqual([]);
  });

  it("delivers the failure notice when a turn cannot be answered", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await handleIncoming(incoming(ALICE, "hello"), sender);
    await drain();
    await deliverPending(sender);
    expect(sender.sent[0].text).toContain("no model API key");
  });
});
