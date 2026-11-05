import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/core/db";
import { listMessages, type ThreadRef } from "../src/core/messages";
import { readAround, searchMessages } from "../src/core/search";
import { buildTools } from "../src/core/tools";
import { drain, FakeAnthropic, makeUser, resetDb, send, text, toolResult, toolUse } from "./harness";

const fake = new FakeAnthropic();
beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(async () => {
  fake.reset();
  await resetDb();
});

const search = (ref: ThreadRef, query: string) => searchMessages(ref, { query, limit: 10, excludeIds: [] });

describe("search_messages", () => {
  it("matches different word forms, not just exact wording", async () => {
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "I booked the flights to Lisbon");
    await send(ref, "nothing relevant here");
    const { hits } = await search(ref, "flight booking");
    expect(hits.map((h) => h.text)).toEqual(["I **booked** the **flights** to Lisbon"]);
  });

  it("falls back to any word, best match first", async () => {
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "my dentist appointment is on Tuesday");
    await send(ref, "pick up the car");
    const { hits, matched } = await search(ref, "dentist invoice paris");
    expect(matched).toBe("any-word");
    expect(hits).toHaveLength(1);
  });

  it("copes with stop words, punctuation and query operators", async () => {
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "plain message");
    for (const query of ["the", "':&|!()", '"unterminated', "-", "a & b | c"]) {
      await expect(search(ref, query)).resolves.toBeTruthy();
    }
  });

  it("only sees the current user's thread", async () => {
    const alice = await makeUser("Acme", "Alice");
    const bob = await makeUser("Acme", "Bob");
    const carol = await makeUser("Globex", "Carol");
    await send(alice, "alice pineapple");
    await send(bob, "bob pineapple");
    await send(carol, "carol pineapple");

    for (const [ref, name] of [[alice, "alice"], [bob, "bob"], [carol, "carol"]] as const) {
      const { hits } = await search(ref, "pineapple");
      expect(hits).toHaveLength(1);
      expect(hits[0].text).toContain(name);
    }
    // Right thread id, wrong tenant: nothing.
    expect((await search({ tenantId: carol.tenantId, threadId: alice.threadId }, "pineapple")).hits).toEqual([]);
    expect(await listMessages({ tenantId: carol.tenantId, threadId: alice.threadId })).toEqual([]);
  });

  it("uses the text index on a realistic table, without planner hints", async () => {
    const ref = await makeUser("Acme", "Alice");
    const other = await makeUser("Acme", "Bob");
    for (const thread of [ref, other]) {
      await db().query(
        `INSERT INTO messages (tenant_id, thread_id, role, content, turn_id)
         SELECT $1, $2, 'user', 'ordinary filler text number ' || n, NULL FROM generate_series(1, 20000) n`,
        [thread.tenantId, thread.threadId],
      );
    }
    await send(ref, "a rare zebra sighting");
    await db().query("ANALYZE messages");
    const { rows } = await db().query(
      `EXPLAIN SELECT id FROM messages
       WHERE tenant_id = $1 AND thread_id = $2 AND search @@ websearch_to_tsquery('english', 'zebra')`,
      [ref.tenantId, ref.threadId],
    );
    const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(plan).toContain("messages_search_idx");
    expect(plan).toMatch(/Index Cond:.*thread_id/);
    expect((await search(ref, "zebras")).hits).toHaveLength(1);
  });

  it("returns a whole short message but a snippet of a long one", async () => {
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "the gate code is 4417");
    await send(ref, `${"filler words here ".repeat(100)} the garage code is 9921 ${"more padding text ".repeat(100)}`);
    const { hits } = await search(ref, "code");
    const texts = hits.map((h) => h.text);
    expect(texts).toContain("the gate **code** is 4417");
    const long = texts.find((t) => t.includes("9921"))!;
    expect(long.length).toBeLessThan(600);
  });

  it("filters by date, with or without a query", async () => {
    const ref = await makeUser("Acme", "Alice");
    const old = await send(ref, "budget review");
    await send(ref, "budget approved");
    await db().query("UPDATE messages SET created_at = '2020-01-15T10:00:00Z' WHERE id = $1", [old.id]);
    const tools = buildTools(ref, "UTC", () => []);
    const run = (input: object) => tools.search_messages.execute!(input as never, {} as never) as Promise<any>;

    const dated = await run({ query: "budget", before: "2021-01-01T00:00:00Z" });
    expect(dated.hits).toHaveLength(1);
    expect(dated.hits[0].at).toContain("15 Jan 2020");

    const browse = await run({ after: "2020-01-01T00:00:00Z", before: "2020-02-01T00:00:00Z" });
    expect(browse.hits[0].text).toBe("budget review");

    expect((await run({ before: "not a date" })).error).toBeTruthy();
    expect((await run({})).error).toBeTruthy();
  });
});

describe("read_messages_around", () => {
  it("returns the neighbours in order", async () => {
    const ref = await makeUser("Acme", "Alice");
    const sent = [];
    for (let i = 0; i < 7; i++) sent.push(await send(ref, `m${i}`));
    const around = await readAround(ref, sent[3].id, { before: 2, after: 1 });
    expect(around!.map((m) => m.text)).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("won't read another thread's message, and won't leak its neighbours", async () => {
    const alice = await makeUser("Acme", "Alice");
    const carol = await makeUser("Globex", "Carol");
    await send(alice, "alice message");
    const secret = await send(carol, "carol secret");
    expect(await readAround(alice, secret.id, { before: 5, after: 5 })).toBeNull();
  });
});

describe("agent flow", () => {
  it("finds an old message through the tools, with its timestamp in the result", async () => {
    const ref = await makeUser("Acme", "Alice");
    const old = await send(ref, "the gate code is 4417");
    await db().query("UPDATE messages SET created_at = '2024-03-02T08:30:00Z' WHERE id = $1", [old.id]);
    await drain();
    fake.reset();
    process.env.HISTORY_TOKEN_BUDGET = "10"; // the old turn is out of the window

    await send(ref, "what's the gate code?");
    fake.handler = (_, index) => {
      if (index === 0) return toolUse("search_messages", { query: "gate code" });
      if (index === 1) return toolUse("read_messages_around", { message_id: old.id });
      return text("4417");
    };
    await drain();
    delete process.env.HISTORY_TOKEN_BUDGET;

    expect(JSON.stringify(fake.requests[0].messages)).not.toContain("4417");
    expect(JSON.stringify(fake.requests[0].messages.at(-1))).toContain("Older messages exist");
    expect(toolResult(fake.requests[1])).toContain("4417");
    expect(toolResult(fake.requests[1])).toContain("2 Mar 2024");
    expect(toolResult(fake.requests[2])).toContain("the gate code is 4417");
    expect(fake.problems).toEqual([]);
  });

  it("does not return the question that triggered the search", async () => {
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "where is my passport?");
    fake.handler = (_, index) => (index === 0 ? toolUse("search_messages", { query: "passport" }) : text("no idea"));
    await drain();
    expect(toolResult(fake.requests[1])).toContain("No matches");
  });
});
