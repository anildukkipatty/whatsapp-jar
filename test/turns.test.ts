import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/core/db";
import { listMessages, receiveMessage } from "../src/core/messages";
import { tick, idle } from "../src/core/worker";
import {
  allText,
  drain,
  FakeAnthropic,
  makeUser,
  resetDb,
  rows,
  send,
  sleep,
  systemText,
  text,
  toolResult,
  toolUse,
  turns,
  type Block,
} from "./harness";

const fake = new FakeAnthropic();

beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(async () => {
  fake.reset();
  await resetDb();
  process.env.ANTHROPIC_API_KEY = "test-key-for-fake-server";
  delete process.env.HISTORY_TOKEN_BUDGET;
});
afterEach(() => expect(fake.problems).toEqual([]));

describe("request to the model", () => {
  it("sends the configured model, adaptive thinking, effort, refusal fallback and the prompt essentials", async () => {
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "hello");
    await drain();

    const [request] = fake.requests;
    expect(request.model).toBe("claude-opus-5-5");
    expect(request.thinking).toEqual({ type: "adaptive" });
    expect(request.output_config).toMatchObject({ effort: "medium" });
    expect(request.fallbacks).toBe("default");
    expect(fake.headers[0]["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    expect(request.tools!.map((t) => t.name).sort()).toEqual([
      "read_messages_around",
      "reply_to_message",
      "search_messages",
    ]);
    expect(systemText(request)).toContain("search first");
    expect(JSON.stringify(request.messages.at(-1))).toContain("Current date and time");
  });

  it("stores the reply as a message with a timestamp", async () => {
    const ref = await makeUser("Acme", "Alice");
    fake.handler = () => text("hi there");
    await send(ref, "hello");
    await drain();
    const list = await listMessages(ref);
    expect(list.map((m) => [m.role, m.content])).toEqual([
      ["user", "hello"],
      ["assistant", "hi there"],
    ]);
    expect(list[1].createdAt).toBeInstanceOf(Date);
  });
});

describe("rolling window", () => {
  it("drops the oldest whole turns and says older history exists", async () => {
    const ref = await makeUser("Acme", "Alice");
    for (let i = 1; i <= 6; i++) {
      await send(ref, `turn-${i} ${"x".repeat(600)}`);
      await drain();
    }
    process.env.HISTORY_TOKEN_BUDGET = "1000"; // about three of these turns
    await send(ref, "latest");
    await drain();

    const request = fake.requests.at(-1)!;
    const seen = allText(request);
    expect(seen).not.toContain("turn-1 ");
    expect(seen).toContain("turn-6 ");
    expect(seen).toContain("latest");
    expect(JSON.stringify(request.messages.at(-1))).toContain("Older messages exist");
    expect(await rows(ref)).toHaveLength(14); // nothing is deleted
  });

  it("keeps tool calls and results together at the cut", async () => {
    const ref = await makeUser("Acme", "Alice");
    for (let i = 1; i <= 5; i++) {
      let calls = 0;
      fake.handler = () => (calls++ === 0 ? toolUse("search_messages", { query: `q${i}` }) : text(`answer-${i}`));
      await send(ref, `turn-${i} ${"y".repeat(400)}`);
      await drain();
    }
    process.env.HISTORY_TOKEN_BUDGET = "1600";
    fake.reset();
    await send(ref, "latest");
    await drain();

    const blocks = fake.requests[0].messages.flatMap((m) => m.content as Block[]);
    const uses = blocks.filter((b) => b.type === "tool_use").map((b) => b.id);
    const results = blocks.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id);
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.length).toBeLessThan(5);
    expect(results).toEqual(uses);
  });

  it("always includes the new batch, even when it alone is over budget", async () => {
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "first");
    await drain();
    process.env.HISTORY_TOKEN_BUDGET = "50";
    await send(ref, `big ${"z".repeat(5000)}`);
    await drain();
    const seen = allText(fake.requests.at(-1)!);
    expect(seen).toContain("big ");
    expect(seen).not.toContain("first");
  });

  it("does not replay thinking from earlier turns but keeps it within a turn", async () => {
    const ref = await makeUser("Acme", "Alice");
    const thinking = { type: "thinking", thinking: "secret", signature: "sig" };
    fake.handler = (_, index) =>
      index === 0
        ? toolUse("search_messages", { query: "a" }, thinking)
        : { content: [thinking, { type: "text", text: "done" }] };
    await send(ref, "one");
    await drain();
    expect(allText(fake.requests[1])).toContain('"thinking"');

    fake.handler = () => text("ok");
    await send(ref, "two");
    await drain();
    expect(allText(fake.requests[2])).not.toContain('"thinking"');
    expect(allText(fake.requests[2])).toContain("done");
    expect(allText(fake.requests[2])).toContain("tool_use");
  });
});

describe("reply to a message", () => {
  it("shows the model a quoted message that has left the window", async () => {
    const ref = await makeUser("Acme", "Alice");
    const old = await send(ref, `the wifi password is hunter2 ${"p".repeat(600)}`);
    await drain();
    for (let i = 0; i < 4; i++) {
      await send(ref, `filler ${"f".repeat(600)}`);
      await drain();
    }
    process.env.HISTORY_TOKEN_BUDGET = "700";
    await send(ref, "is this still right?", old.id);
    await drain();

    const request = fake.requests.at(-1)!;
    const lastUser = JSON.stringify(request.messages.at(-1));
    expect(lastUser).toContain("hunter2");
    expect(lastUser).toContain(`replying to msg ${old.id}`);
    expect((await listMessages(ref)).find((m) => m.content === "is this still right?")?.replyTo?.id).toBe(old.id);
  });

  it("lets the agent quote a specific message, one bubble per task", async () => {
    const ref = await makeUser("Acme", "Alice");
    const a = await send(ref, "weather?");
    const b = await send(ref, "2+2?");
    fake.handler = (_, index) => {
      if (index === 0) return toolUse("reply_to_message", { message_id: a.id, text: "sunny" });
      if (index === 1) return toolUse("reply_to_message", { message_id: b.id, text: "4" });
      return { content: [] }; // nothing more to say
    };
    await drain();

    const replies = (await rows(ref)).filter((m) => m.role === "assistant");
    expect(replies.map((m) => [m.content, m.reply_to_id])).toEqual([
      ["sunny", a.id],
      ["4", b.id],
    ]);
    await send(ref, "thanks");
    fake.handler = () => text("np");
    await drain();
  });

  it("doesn't send text the model writes alongside a tool call", async () => {
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "hello");
    fake.handler = (_, index) =>
      index === 0
        ? toolUse("search_messages", { query: "a" }, { type: "text", text: "I'll search first." })
        : text("the answer");
    await drain();
    expect((await rows(ref)).filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["the answer"]);
  });

  it("rejects a reply to a message outside the thread, from the user or the agent", async () => {
    const alice = await makeUser("Acme", "Alice");
    const bob = await makeUser("Acme", "Bob");
    const carol = await makeUser("Globex", "Carol");
    const secret = await send(carol, "carol secret");
    const bobs = await send(bob, "bob note");
    await drain();

    await expect(send(alice, "nope", secret.id)).rejects.toThrow("not found");
    await expect(send(alice, "nope", bobs.id)).rejects.toThrow("not found");
    await expect(
      db().query(
        `INSERT INTO messages (tenant_id, thread_id, role, content, reply_to_id) VALUES ($1, $2, 'user', 'x', $3)`,
        [alice.tenantId, alice.threadId, secret.id],
      ),
    ).rejects.toThrow("foreign key");

    fake.handler = (_, index) =>
      index === 2 ? toolUse("reply_to_message", { message_id: secret.id, text: "leak" }) : text("sorry");
    await send(alice, "go");
    await drain();
    expect(toolResult(fake.requests[3])).toContain("not found");
    expect((await rows(alice)).map((m) => m.content)).not.toContain("leak");
  });
});

describe("back-to-back messages", () => {
  it("batches a rapid burst into one turn, in order", async () => {
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "book a table");
    await sleep(40);
    await tick();
    await send(ref, "also what is 2+2");
    await sleep(40);
    await tick();
    await send(ref, "and remind me about rent");
    expect(fake.requests).toHaveLength(0); // still debouncing
    await drain();

    expect(fake.requests).toHaveLength(1);
    const blocks = fake.requests[0].messages.at(-1)!.content as Block[];
    expect(blocks.slice(0, 3).map((b) => b.text.split("\n")[1])).toEqual([
      "book a table",
      "also what is 2+2",
      "and remind me about rent",
    ]);
    expect(blocks[3].text).toContain("<system-reminder>");
    expect(new Set((await rows(ref)).map((m) => m.turn_id)).size).toBe(1);
  });

  it("does not let nonstop typing starve the thread", async () => {
    const ref = await makeUser("Acme", "Alice");
    process.env.DEBOUNCE_MAX_MS = "300";
    const start = Date.now();
    while (Date.now() - start < 500 && !fake.requests.length) {
      await send(ref, "more");
      await tick();
      await sleep(30);
    }
    process.env.DEBOUNCE_MAX_MS = "1000";
    await idle();
    expect(fake.requests.length).toBeGreaterThan(0);
    await drain();
  });

  it("picks up a message that arrives while a tool step is running", async () => {
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "first task");
    fake.handler = async (_, index) => {
      if (index === 0) {
        await send(ref, "second task, mid-turn");
        return toolUse("search_messages", { query: "something" });
      }
      return text("did both");
    };
    await drain();

    expect(fake.requests).toHaveLength(2);
    const last = fake.requests[1].messages.at(-1)!;
    const kinds = (last.content as Block[]).map((b) => b.type);
    expect(kinds).toEqual(["tool_result", "text"]);
    expect(JSON.stringify(last)).toContain("second task, mid-turn");

    const stored = await rows(ref);
    expect(new Set(stored.map((m) => m.turn_id)).size).toBe(1);
    const [turn] = await turns(ref);
    expect(turn.transcript.map((m: { role: string }) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
      "assistant",
    ]);

    // The next turn replays it in the same order, and the shape stays valid.
    fake.handler = () => text("ok");
    await send(ref, "third");
    await drain();
    expect(allText(fake.requests[2])).toContain("second task, mid-turn");
  });

  it("runs a message that arrives during the final step as its own next turn", async () => {
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "first");
    fake.handler = async (_, index) => {
      if (index === 0) await send(ref, "too late for this turn");
      return text(`reply ${index}`);
    };
    await drain();

    expect(fake.requests).toHaveLength(2);
    expect(allText(fake.requests[1])).toContain("too late for this turn");
    expect(fake.maxInFlight).toBe(1);
    const stored = await rows(ref);
    expect(stored.filter((m) => m.role === "user" && m.turn_id == null)).toEqual([]);
    expect(stored.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["reply 0", "reply 1"]);
  });

  it("never runs two turns at once for a thread, but runs different threads in parallel", async () => {
    const alice = await makeUser("Acme", "Alice");
    const bob = await makeUser("Acme", "Bob");
    await send(alice, "a");
    await send(bob, "b");
    await sleep(200);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    fake.handler = async () => {
      await gate;
      return text("ok");
    };
    await Promise.all([tick(), tick(), tick()]);
    await sleep(100);
    expect(fake.requests).toHaveLength(2);
    expect(fake.maxInFlight).toBe(2);

    await send(alice, "while running");
    await sleep(200);
    await tick();
    await sleep(50);
    expect(fake.requests).toHaveLength(2); // alice's lease still held, so nothing new starts
    release();
    await drain();
    expect(fake.requests).toHaveLength(3);
  });

  it("stores a redelivered message once", async () => {
    const ref = await makeUser("Acme", "Alice");
    const input = { text: "once", dedupeKey: "wamid.123" };
    const [a, b] = await Promise.all([receiveMessage(ref, input), receiveMessage(ref, input)]);
    expect(a.id).toBe(b.id);
    expect(await rows(ref)).toHaveLength(1);
    await drain();
  });
});

describe("failure", () => {
  it("reruns a batch left behind by a crashed worker once its lease expires", async () => {
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "survive this");
    await db().query(
      "UPDATE threads SET lease_owner = gen_random_uuid(), lease_expires_at = now() + interval '1 hour' WHERE id = $1",
      [ref.threadId],
    );
    await sleep(200);
    await tick();
    await idle();
    expect(fake.requests).toHaveLength(0); // lease still live

    await db().query("UPDATE threads SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [
      ref.threadId,
    ]);
    await drain();
    expect((await rows(ref)).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("discards the result of a worker that lost its lease mid-turn", async () => {
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "hello");
    await sleep(200);
    fake.handler = async () => {
      await db().query("UPDATE threads SET lease_owner = gen_random_uuid() WHERE id = $1", [ref.threadId]);
      return text("stale reply");
    };
    await tick();
    await idle();
    let stored = await rows(ref);
    expect(stored).toHaveLength(1);
    expect(stored[0].turn_id).toBeNull();
    expect(await turns(ref)).toHaveLength(0);

    await db().query("UPDATE threads SET lease_owner = NULL, lease_expires_at = NULL, retry_at = NULL WHERE id = $1", [
      ref.threadId,
    ]);
    fake.handler = () => text("fresh reply");
    await drain();
    stored = await rows(ref);
    expect(stored.map((m) => m.content)).toEqual(["hello", "fresh reply"]);
  });

  it("retries a transient model failure without losing or duplicating anything", async () => {
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "hello");
    fake.handler = (_, index) => (index < 3 ? { status: 500 } : text("recovered"));
    await drain(15_000);
    expect((await rows(ref)).map((m) => m.content)).toEqual(["hello", "recovered"]);
  });

  it("posts a notice and moves on when the model rejects the request", async () => {
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "hello");
    fake.handler = () => ({ status: 400, error: "bad request" });
    await drain();
    expect(fake.requests).toHaveLength(1); // not retried
    const stored = await rows(ref);
    expect(stored.map((m) => m.role)).toEqual(["user", "system"]);

    fake.handler = () => text("back");
    await send(ref, "again?");
    await drain();
    const seen = allText(fake.requests.at(-1)!);
    expect(seen).toContain("went unanswered"); // the model knows the first message got no reply
    expect(seen).toContain("hello");
  });

  it("says so in the chat when no API key is set", async () => {
    const ref = await makeUser("Acme", "Alice");
    delete process.env.ANTHROPIC_API_KEY;
    await send(ref, "hello");
    await drain();
    expect(fake.requests).toHaveLength(0);
    const notice = (await rows(ref)).at(-1)!;
    expect(notice.role).toBe("system");
    expect(notice.content).toContain("no model API key");
  });

  it("treats a blank API key, as in a fresh .env, the same as a missing one", async () => {
    const ref = await makeUser("Acme", "Alice");
    process.env.ANTHROPIC_API_KEY = "";
    await send(ref, "hello");
    await drain();
    expect(fake.requests).toHaveLength(0);
    expect((await rows(ref)).at(-1)!.content).toContain("no model API key");
  });

  it("posts a notice when the model produces no reply at all", async () => {
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "hello");
    fake.handler = () => ({ content: [], stop_reason: "refusal" });
    await drain();
    expect((await rows(ref)).map((m) => m.role)).toEqual(["user", "system"]);
  });

  it("forces an answer on the last step rather than ending on a tool call", async () => {
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "loop forever");
    fake.handler = (request) =>
      request.tool_choice?.type === "none" ? text("best answer I have") : toolUse("search_messages", { query: "x" });
    await drain();
    expect(fake.requests).toHaveLength(12);
    expect(JSON.stringify(fake.requests[11].messages.at(-1))).toContain("no more tool calls");
    expect(JSON.stringify(fake.requests[10].messages.at(-1))).not.toContain("no more tool calls");
    expect((await rows(ref)).at(-1)!.content).toBe("best answer I have");
  });
});
