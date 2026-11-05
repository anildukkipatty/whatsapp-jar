import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/core/db";
import { listMessages, type Message } from "../src/core/messages";
import { addStep, emptyUsage, PRICES, type BilledStep } from "../src/core/pricing";
import { searchMessages } from "../src/core/search";
import { allText, drain, FakeAnthropic, makeUser, resetDb, rows, send, text, toolUse, type Reply } from "./harness";

const fake = new FakeAnthropic();
beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(async () => {
  fake.reset();
  await resetDb();
  process.env.ANTHROPIC_API_KEY = "test-key-for-fake-server";
  delete process.env.AGENT_MODEL;
});
afterEach(() => expect(fake.problems).toEqual([]));

const withUsage = (reply: Reply, usage: object, extra: Partial<Reply> = {}): Reply => ({ ...reply, usage, ...extra });
const usageRows = (list: Message[]) => list.filter((m) => m.usage);

function step(input: Partial<BilledStep> & { tokens?: object; raw?: object } = {}): BilledStep {
  return {
    finishReason: "stop",
    content: [{ type: "text" }],
    response: { modelId: "claude-opus-5-5" },
    usage: {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      inputTokenDetails: { noCacheTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, ...input.tokens },
      outputTokenDetails: {},
      raw: input.raw,
    } as BilledStep["usage"],
    ...input,
  };
}

describe("cost", () => {
  const costOf = (...steps: BilledStep[]) => {
    const total = emptyUsage();
    steps.forEach((s) => addStep(total, s));
    return total.costUsd;
  };

  it("uses the published Opus 5.5 rates", () => {
    expect(PRICES["claude-opus-5-5"]).toEqual({ input: 4, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20 });
    expect(costOf(step())).toBe(24);
  });

  it("prices cache reads and writes at their own rates, not again as input", () => {
    const tokens = { noCacheTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 };
    expect(costOf(step({ tokens }))).toBeCloseTo(0.2 + 5 + 20);
  });

  it("prices 1-hour cache writes higher than 5-minute ones", () => {
    const tokens = { noCacheTokens: 0, cacheWriteTokens: 1_000_000 };
    const raw = { cache_creation: { ephemeral_1h_input_tokens: 400_000, ephemeral_5m_input_tokens: 600_000 } };
    expect(costOf(step({ tokens, raw }))).toBeCloseTo(0.4 * 8 + 0.6 * 5 + 20);
  });

  it("prices each step at the model that served it", () => {
    expect(costOf(step(), step({ response: { modelId: "claude-opus-4-8" } }))).toBe(24 + 30);
  });

  it("has no cost for an unknown model, and never a partial total", () => {
    expect(costOf(step({ response: { modelId: "claude-new" } }))).toBeNull();
    expect(costOf(step(), step({ response: { modelId: "claude-new" } }), step())).toBeNull();
  });

  it("doesn't charge a refusal before any output unless its category is billed", () => {
    const refused = (category: string | null) =>
      step({ finishReason: "content-filter", content: [], providerMetadata: { anthropic: { stopDetails: { category } } } });
    expect(costOf(refused("cyber"))).toBe(0);
    expect(costOf(refused(null))).toBe(0);
    expect(costOf(refused("bio"))).toBe(24);
  });

  it("leaves cost out when a declined attempt came before a fallback, but prices a sticky fallback", () => {
    const meta = (iterations: object[]) => ({ anthropic: { iterations } }) as BilledStep["providerMetadata"];
    const served = { type: "fallback_message" };
    expect(costOf(step({ providerMetadata: meta([{ type: "message" }, served]) }))).toBeNull();
    expect(costOf(step({ providerMetadata: meta([served]), response: { modelId: "claude-opus-4-8" } }))).toBe(30);
  });
});

describe("usage line data", () => {
  it("totals every step of a turn, with input including cached tokens", async () => {
    const ref = await makeUser("Acme", "Alice");
    fake.handler = (_, index) =>
      index === 0
        ? withUsage(toolUse("search_messages", { query: "x" }), {
            input_tokens: 1000,
            output_tokens: 100,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 200,
          })
        : withUsage(text("done"), { input_tokens: 2000, output_tokens: 50 });
    await send(ref, "hello");
    await drain();

    const usage = (await listMessages(ref)).at(-1)!.usage!;
    expect(usage).toMatchObject({ inputTokens: 3700, outputTokens: 150, cacheReadTokens: 500, cacheWriteTokens: 200 });
    // (3000 * 4 + 500 * 0.2 + 200 * 5 + 150 * 20) / 1e6
    expect(usage.costUsd).toBeCloseTo(0.0161, 6);
  });

  it("attaches once per turn, to the last reply, and survives a reload and paging back", async () => {
    const ref = await makeUser("Acme", "Alice");
    const a = await send(ref, "first");
    fake.handler = (_, index) => {
      if (index === 0) return toolUse("reply_to_message", { message_id: a.id, text: "quoted bubble" });
      return text("closing bubble");
    };
    await drain();
    fake.handler = () => text("later");
    for (let i = 0; i < 3; i++) {
      await send(ref, `more ${i}`);
      await drain();
    }

    const all = await listMessages(ref);
    expect(usageRows(all).map((m) => m.content)).toEqual(["closing bubble", "later", "later", "later"]);
    const lastPage = await listMessages(ref, { limit: 2 });
    expect(lastPage.at(-1)!.usage).toBeTruthy();
    const olderPage = await listMessages(ref, { beforeId: all[3].id, limit: 3 });
    expect(usageRows(olderPage).map((m) => m.content)).toEqual(["closing bubble"]);
    const polled = await listMessages(ref, { afterId: all.at(-2)!.id });
    expect(polled[0].usage).toBeTruthy();
  });

  it("shows tokens without cost for a model with no known price", async () => {
    const ref = await makeUser("Acme", "Alice");
    process.env.AGENT_MODEL = "claude-not-in-the-table";
    await send(ref, "hello");
    await drain();
    expect((await listMessages(ref)).at(-1)!.usage).toMatchObject({ inputTokens: 10, outputTokens: 10, costUsd: null });
  });

  it("prices a fallback at the model named in the response", async () => {
    const ref = await makeUser("Acme", "Alice");
    fake.handler = () =>
      withUsage(text("ok"), { input_tokens: 1000, output_tokens: 0, iterations: [{ type: "fallback_message", model: "claude-opus-4-8", input_tokens: 1000, output_tokens: 0 }] }, { model: "claude-opus-4-8" });
    await send(ref, "hello");
    await drain();
    expect((await listMessages(ref)).at(-1)!.usage!.costUsd).toBeCloseTo(0.005, 6);
  });

  it("never reaches the model, the window or search", async () => {
    const ref = await makeUser("Acme", "Alice");
    fake.handler = () => withUsage(text("noted"), { input_tokens: 7771234, output_tokens: 8881234 });
    await send(ref, "first");
    await drain();

    fake.handler = () => text("ok");
    await send(ref, "second");
    await drain();
    const request = JSON.stringify(fake.requests.at(-1));
    expect(allText(fake.requests.at(-1)!)).toContain("noted"); // the turn is in the window
    expect(request).not.toContain("7771234");
    expect(request).not.toContain("8881234");
    expect(allText(fake.requests.at(-1)!)).not.toContain("$");

    const { rows: stored } = await db().query("SELECT transcript::text, token_estimate FROM turns ORDER BY id LIMIT 1");
    expect(stored[0].transcript).not.toContain("7771234");
    expect(stored[0].token_estimate).toBeLessThan(200);
    expect((await searchMessages(ref, { query: "7771234", limit: 5, excludeIds: [] })).hits).toEqual([]);
  });

  it("is scoped by tenant", async () => {
    const alice = await makeUser("Acme", "Alice");
    const carol = await makeUser("Globex", "Carol");
    await send(alice, "hi");
    await drain();
    expect(usageRows(await listMessages(alice))).toHaveLength(1);
    expect(await listMessages({ tenantId: carol.tenantId, threadId: alice.threadId })).toEqual([]);
    await send(carol, "hi");
    await drain();
    await expect(
      db().query("UPDATE turns SET last_message_id = $1 WHERE tenant_id = $2", [
        (await rows(alice))[0].id,
        carol.tenantId,
      ]),
    ).rejects.toThrow("foreign key");
  });
});

describe("failed turns", () => {
  it("keeps what was billed when a later step fails, on the failure notice", async () => {
    const ref = await makeUser("Acme", "Alice");
    fake.handler = (_, index) =>
      index === 0
        ? withUsage(toolUse("search_messages", { query: "x" }), { input_tokens: 1000, output_tokens: 100 })
        : { status: 400, error: "bad" };
    await send(ref, "hello");
    await drain();

    const notice = (await listMessages(ref)).at(-1)!;
    expect(notice.role).toBe("system");
    expect(notice.usage).toMatchObject({ inputTokens: 1000, outputTokens: 100 });
    expect(notice.usage!.costUsd).toBeCloseTo(0.006, 6);
  });

  it("adds a failed attempt's usage to the retry that succeeds", async () => {
    const ref = await makeUser("Acme", "Alice");
    fake.handler = (_, index) => {
      if (index === 0) return withUsage(toolUse("search_messages", { query: "x" }), { input_tokens: 1000, output_tokens: 100 });
      if (index <= 3) return { status: 500 };
      return withUsage(text("recovered"), { input_tokens: 2000, output_tokens: 50 });
    };
    await send(ref, "hello");
    await drain(15_000);

    expect((await listMessages(ref)).at(-1)!.usage).toMatchObject({ inputTokens: 3000, outputTokens: 150 });
    const { rows: thread } = await db().query("SELECT carried_usage FROM threads WHERE id = $1", [ref.threadId]);
    expect(thread[0].carried_usage).toBeNull();
  });

  it("shows nothing when no model call was made", async () => {
    const ref = await makeUser("Acme", "Alice");
    delete process.env.ANTHROPIC_API_KEY;
    await send(ref, "hello");
    await drain();
    expect(usageRows(await listMessages(ref))).toEqual([]);
  });

  it("shows tokens at no cost for an unbilled refusal", async () => {
    const ref = await makeUser("Acme", "Alice");
    fake.handler = () => ({
      content: [],
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: null },
      usage: { input_tokens: 500, output_tokens: 0 },
    });
    await send(ref, "hello");
    await drain();
    expect((await listMessages(ref)).at(-1)!.usage).toMatchObject({ inputTokens: 500, costUsd: 0 });
  });
});
