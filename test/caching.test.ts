import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/core/db";
import { listMessages } from "../src/core/messages";
import { searchMessages } from "../src/core/search";
import { pickWindowStart } from "../src/core/window";
import {
  drain,
  FakeAnthropic,
  makeUser,
  promptBlocks,
  resetDb,
  send,
  systemText,
  text,
  toolUse,
  turns,
  type Request,
} from "./harness";

const fake = new FakeAnthropic();
beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(async () => {
  fake.reset();
  await resetDb();
  process.env.ANTHROPIC_API_KEY = "test-key-for-fake-server";
  delete process.env.HISTORY_TOKEN_BUDGET;
  delete process.env.PROMPT_CACHE_TTL;
});
afterEach(() => {
  vi.useRealTimers();
  expect(fake.problems).toEqual([]);
});

/** Each turn's first request must begin with the previous turn's first request, block for block. */
function expectPrefixesHold(first: Request[]) {
  expect(first.length).toBeGreaterThan(1);
  for (let i = 1; i < first.length; i++) {
    const before = promptBlocks(first[i - 1]);
    expect(promptBlocks(first[i]).slice(0, before.length)).toEqual(before);
    expect(systemText(first[i])).toBe(systemText(first[0]));
    expect(JSON.stringify(first[i].tools)).toBe(JSON.stringify(first[0].tools));
  }
}

const thinking = { type: "thinking", thinking: "", signature: "sig" };

describe("prompt prefix", () => {
  it("stays byte-identical across turns, as the clock moves on", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-05T09:00:00Z") });
    const ref = await makeUser("Acme", "Alice");
    const first: Request[] = [];
    for (const [i, day] of [5, 6, 7, 8].entries()) {
      vi.setSystemTime(new Date(`2026-11-0${day}T09:00:00Z`));
      fake.handler = (request) => {
        first.push(request);
        return text(`reply ${i}`);
      };
      await send(ref, `message ${i}`);
      await drain();
    }
    expectPrefixesHold(first);
    expect(JSON.stringify(first[0].messages.at(-1))).toContain("5 Nov 2026");
    expect(JSON.stringify(first[3].messages)).toContain("5 Nov 2026"); // replayed unchanged
    expect(JSON.stringify(first[3].messages.at(-1))).toContain("8 Nov 2026");
  });

  it("holds through tool turns, thinking, batches, quotes, mid-turn messages and silent endings", async () => {
    const ref = await makeUser("Acme", "Alice");
    const first: Request[] = [];
    const script = async (steps: ((request: Request) => ReturnType<typeof text> | Promise<ReturnType<typeof text>>)[]) => {
      let step = 0;
      fake.handler = (request) => {
        if (step === 0) first.push(request);
        return steps[step++](request);
      };
      await drain();
    };

    const a = await send(ref, "plain");
    await script([() => text("first")]);

    await send(ref, "one");
    await send(ref, "two");
    await script([
      () => toolUse("search_messages", { limit: 3, query: "zz" }, thinking),
      () => ({ content: [thinking, { type: "text", text: "with tools" }] }),
    ]);

    await send(ref, "quoting", a.id);
    await script([
      async () => {
        await send(ref, "sent mid-turn");
        return toolUse("search_messages", { query: "yy" });
      },
      () => toolUse("reply_to_message", { message_id: a.id, text: "quoted reply" }),
      () => ({ content: [] }), // ends on a tool result, so the next batch shares its block
    ]);

    await send(ref, "after silence");
    await script([() => text("done")]);
    await send(ref, "last");
    await script([() => text("end")]);

    expect(first).toHaveLength(5);
    expectPrefixesHold(first);
  });

  it("doesn't send thinking from earlier turns, so replay is the same every time", async () => {
    const ref = await makeUser("Acme", "Alice");
    fake.handler = (_, index) =>
      index === 0 ? toolUse("search_messages", { query: "x" }, thinking) : { content: [thinking, { type: "text", text: "a" }] };
    await send(ref, "one");
    await drain();
    const [turn] = await turns(ref);
    expect(JSON.stringify(turn.transcript)).not.toContain('"reasoning"');
  });
});

describe("breakpoints", () => {
  it("uses automatic caching plus one read point on the previous batch, never stored", async () => {
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "one");
    await drain();
    expect(fake.requests[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(JSON.stringify(fake.requests[0].messages)).not.toContain("cache_control");

    for (const message of ["two", "three", "four"]) {
      await send(ref, message);
      await drain();
    }
    const request = fake.requests.at(-1)!;
    const blocks = request.messages.flatMap((m) => m.content as { text?: string; cache_control?: object }[]);
    const marked = blocks.filter((b) => b.cache_control);
    expect(marked).toHaveLength(1);
    expect(marked[0].text).toContain("<system-reminder>");
    expect(blocks.indexOf(marked[0])).toBe(blocks.length - 4); // then its reply, and this batch's text and reminder

    const { rows } = await db().query("SELECT transcript::text FROM turns");
    for (const row of rows) expect(row.transcript).not.toMatch(/cacheControl|cache_control/);
  });

  it("keeps one breakpoint moving through the steps of a long turn", async () => {
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "start");
    await drain();
    await send(ref, "long turn");
    let calls = 0;
    fake.handler = () => (++calls < 6 ? toolUse("search_messages", { query: "x" }) : text("done"));
    await drain();
    for (const request of fake.requests) expect(request.cache_control).toBeTruthy();
    expect(fake.problems).toEqual([]);
  });

  it("can use a 5-minute TTL", async () => {
    process.env.PROMPT_CACHE_TTL = "5m";
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "one");
    await drain();
    await send(ref, "two");
    await drain();
    expect(fake.requests[1].cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    expect(JSON.stringify(fake.requests[1].messages)).toContain('"ttl":"5m"');
  });
});

describe("reminder", () => {
  it("is kept out of the chat, search and quotes", async () => {
    const ref = await makeUser("Acme", "Alice");
    const a = await send(ref, "remember the bicycle");
    await drain();
    await send(ref, "what about it?", a.id);
    await drain();
    await send(ref, "and now");
    await drain();

    const list = await listMessages(ref);
    expect(JSON.stringify(list)).not.toMatch(/system-reminder|Current date and time/);
    for (const query of ["system-reminder", "current date time", "reminder"]) {
      expect((await searchMessages(ref, { query, limit: 10, excludeIds: [] })).hits).toEqual([]);
    }
    const lastUser = JSON.stringify(fake.requests.at(-1)!.messages.at(-1));
    expect(lastUser.match(/<system-reminder>/g)).toHaveLength(1);
    const quoted = fake.requests[1].messages.at(-1)!.content as { text: string }[];
    expect(quoted[0].text).not.toContain("system-reminder");
  });

  it("is added once per turn, not to messages that arrive mid-turn", async () => {
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "first");
    fake.handler = async (_, index) => {
      if (index === 0) {
        await send(ref, "mid");
        return toolUse("search_messages", { query: "x" });
      }
      return text("ok");
    };
    await drain();
    expect(JSON.stringify(fake.requests[1].messages).match(/<system-reminder>/g)).toHaveLength(1);
  });

  it("leaves the system prompt free of anything that changes", async () => {
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "hi");
    await drain();
    const system = systemText(fake.requests[0]);
    expect(system).not.toMatch(/20\d\d|Current date and time:|Older messages exist/);
  });
});

describe("rolling window", () => {
  const turnsOf = (count: number, size: (i: number) => number) =>
    Array.from({ length: count }, (_, i) => ({ id: i + 1, tokens: size(i) }));

  function simulate(sizes: number[], budget: number, pick: typeof pickWindowStart) {
    let window: { id: number; tokens: number }[] = [];
    let moves = 0;
    sizes.forEach((tokens, i) => {
      const start = pick(window, 100, budget);
      if (start > 0) moves++;
      window = [...window.slice(start), { id: i + 1, tokens }];
    });
    return moves;
  }

  it("moves far less often than trimming one turn at a time", () => {
    const sizes = turnsOf(2000, (i) => (i % 5 === 0 ? 1200 : 150)).map((t) => t.tokens); // tool turn every 5th
    const oneByOne: typeof pickWindowStart = (turns, batch, budget) => {
      let total = turns.reduce((sum, t) => sum + t.tokens, batch);
      let start = 0;
      while (total > budget) total -= turns[start++].tokens;
      return start;
    };
    const naive = simulate(sizes, 24_000, oneByOne);
    const chunked = simulate(sizes, 24_000, pickWindowStart);
    expect(naive).toBeGreaterThan(700);
    expect(chunked).toBeLessThan(naive / 10);
  });

  it("never moves back after a large batch, unlike a window recomputed each turn", async () => {
    const ref = await makeUser("Acme", "Alice");
    process.env.HISTORY_TOKEN_BUDGET = "2000";
    for (let i = 0; i < 4; i++) {
      await send(ref, `turn-${i} ${"x".repeat(900)}`);
      await drain();
    }
    await send(ref, `big ${"z".repeat(4000)}`);
    await drain();
    const afterBig = fake.requests.at(-1)!;
    expect(JSON.stringify(afterBig.messages)).not.toContain("turn-0 ");

    await send(ref, "small");
    await drain();
    expect(JSON.stringify(fake.requests.at(-1)!.messages)).not.toContain("turn-0 ");
  });

  it("holds the prefix until the budget is hit, then trims to half", async () => {
    const ref = await makeUser("Acme", "Alice");
    process.env.HISTORY_TOKEN_BUDGET = "3000";
    const first: Request[] = [];
    fake.handler = (request) => {
      first.push(request);
      return text("ok");
    };
    for (let i = 0; i < 12; i++) {
      await send(ref, `turn-${i} ${"x".repeat(600)}`);
      await drain();
    }
    const moves = first.filter((request, i) => {
      if (i === 0) return false;
      const before = promptBlocks(first[i - 1]);
      return promptBlocks(request).slice(0, before.length).join() !== before.join();
    }).length;
    expect(moves).toBe(1);
    expect(promptBlocks(first.at(-1)!).length).toBeGreaterThan(4);
  });

  it("keeps whole turns when it trims", () => {
    const window = turnsOf(10, () => 300);
    expect(pickWindowStart(window, 0, 3000)).toBe(0);
    expect(pickWindowStart(window, 100, 3000)).toBe(6); // 100 + 4 * 300 <= 1500
    expect(pickWindowStart(window, 5000, 3000)).toBe(10);
  });
});
