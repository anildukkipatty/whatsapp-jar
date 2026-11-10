import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMcp } from "../src/core/mcp";
import { parseSkill } from "../src/core/skills";
import {
  allText,
  drain,
  FakeAnthropic,
  makeUser,
  resetDb,
  rows,
  send,
  systemText,
  text,
  toolResult,
  toolUse,
  turns,
  type Block,
} from "./harness";

type McpTool = { name: string; description: string; inputSchema: Block };
type CallResult = { content: Block[]; isError?: boolean };

/** Stands in for an MCP server over streamable HTTP, answering with plain JSON. */
class FakeMcp {
  calls: { name: string; arguments: Block }[] = [];
  methods: string[] = [];
  instructions: string | undefined = "Use run_python for market data.";
  tools: McpTool[] = [];
  onCall: (name: string, args: Block) => CallResult | "http-500" = () => ({ content: [{ type: "text", text: "42" }] });
  private server?: Server;
  url = "";

  async start() {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const message = JSON.parse(Buffer.concat(chunks).toString());
      this.methods.push(message.method);
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const reply = (body: Block) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...body }));
      };
      if (message.method === "initialize") {
        return reply({
          result: {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "fake", version: "1" },
            ...(this.instructions && { instructions: this.instructions }),
          },
        });
      }
      if (message.method === "tools/list") return reply({ result: { tools: this.tools } });
      if (message.method === "tools/call") {
        this.calls.push({ name: message.params.name, arguments: message.params.arguments });
        const result = this.onCall(message.params.name, message.params.arguments);
        if (result === "http-500") {
          res.writeHead(500).end("boom");
          return;
        }
        return reply({ result });
      }
      reply({ error: { code: -32601, message: "Method not found" } });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}/mcp`;
  }

  reset() {
    this.calls = [];
    this.methods = [];
    this.instructions = "Use run_python for market data.";
    this.tools = [
      {
        name: "run_python",
        description: "Run a Python script and return what it prints.",
        inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
      },
    ];
    this.onCall = () => ({ content: [{ type: "text", text: "42" }] });
  }

  stop() {
    this.server?.close();
  }
}

const fake = new FakeAnthropic();
const mcp = new FakeMcp();
const scratch = mkdtempSync(join(tmpdir(), "jar-mcp-test-"));

function useServers(servers: Record<string, { url: string }>) {
  const path = join(scratch, `mcp-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ mcpServers: servers }));
  process.env.MCP_CONFIG = path;
}

function useSkills(files: Record<string, string>) {
  const dir = mkdtempSync(join(scratch, "skills-"));
  for (const [folder, source] of Object.entries(files)) {
    mkdirSync(join(dir, folder));
    writeFileSync(join(dir, folder, "SKILL.md"), source);
  }
  process.env.SKILLS_DIR = dir;
}

const SKILL_BODY = "# Markets\nAlways write one script with `import slashdhan as z` and print only the answer.";
const SKILL = `---\nname: markets\ndescription: "Indian market data through run_python."\n---\n\n${SKILL_BODY}\n`;

beforeAll(async () => {
  await fake.start();
  await mcp.start();
});
afterAll(() => {
  fake.stop();
  mcp.stop();
});
beforeEach(async () => {
  fake.reset();
  mcp.reset();
  await resetMcp();
  await resetDb();
  process.env.MCP_CONFIG = "";
  process.env.SKILLS_DIR = "";
});
afterEach(() => {
  expect(fake.problems).toEqual([]);
});

const toolNames = (index: number) => (fake.requests[index].tools ?? []).map((t) => t.name);

describe("MCP tools", () => {
  it("offers the server's tools and notes, byte-identical on every turn", async () => {
    useServers({ dhan: { url: mcp.url } });
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "first");
    await drain();
    await send(ref, "second");
    await drain();

    expect(toolNames(0)).toEqual(["search_messages", "read_messages_around", "reply_to_message", "run_python"]);
    const tool = fake.requests[0].tools!.find((t) => t.name === "run_python")!;
    expect(tool.description).toBe("Run a Python script and return what it prints.");
    expect(tool.input_schema.required).toEqual(["code"]);
    expect(systemText(fake.requests[0])).toContain("- dhan: Use run_python for market data.");
    expect(JSON.stringify(fake.requests[1].tools)).toBe(JSON.stringify(fake.requests[0].tools));
    expect(systemText(fake.requests[1])).toBe(systemText(fake.requests[0]));
    // Connected once for the life of the process, not once per turn.
    expect(mcp.methods.filter((m) => m === "initialize")).toHaveLength(1);
    expect(mcp.methods.filter((m) => m === "tools/list")).toHaveLength(1);
  });

  it("runs a tool on the server and gives the model what it printed", async () => {
    useServers({ dhan: { url: mcp.url } });
    mcp.onCall = () => ({ content: [{ type: "text", text: "NIFTY 22,749.75" }] });
    fake.handler = (_, index) => (index === 0 ? toolUse("run_python", { code: "print(1)" }) : text("NIFTY is at 22,749.75"));
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "where is nifty?");
    await drain();

    expect(mcp.calls).toEqual([{ name: "run_python", arguments: { code: "print(1)" } }]);
    expect(toolResult(fake.requests[1])).toContain("NIFTY 22,749.75");
    expect((await rows(ref)).at(-1)!.content).toBe("NIFTY is at 22,749.75");
  });

  it("caps a long output so one call can't flood the context or the window", async () => {
    useServers({ dhan: { url: mcp.url } });
    mcp.onCall = () => ({ content: [{ type: "text", text: "x".repeat(50_000) }] });
    fake.handler = (_, index) => (index === 0 ? toolUse("run_python", { code: "dump" }) : text("done"));
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "dump everything");
    await drain();

    const result = toolResult(fake.requests[1]);
    expect(result).toContain("Output truncated: 50,000 characters, showing the first 10,000. Print less.");
    expect(result.length).toBeLessThan(10_500);
    const [turn] = await turns(ref);
    expect(JSON.stringify(turn.transcript).length).toBeLessThan(12_000);
  });

  it("passes a tool's own error to the model and still answers", async () => {
    useServers({ dhan: { url: mcp.url } });
    mcp.onCall = () => ({ content: [{ type: "text", text: "Traceback: NameError: z" }], isError: true });
    fake.handler = (_, index) => (index === 0 ? toolUse("run_python", { code: "z.ltp()" }) : text("That failed, sorry."));
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "price?");
    await drain();

    expect(toolResult(fake.requests[1])).toContain("Traceback: NameError: z");
    expect(toolResult(fake.requests[1])).toContain("error");
    expect((await rows(ref)).at(-1)!.content).toBe("That failed, sorry.");
  });

  it("reports a broken connection to the model, then reconnects on the next turn", async () => {
    useServers({ dhan: { url: mcp.url } });
    mcp.onCall = () => "http-500";
    fake.handler = (_, index) => (index === 0 ? toolUse("run_python", { code: "1" }) : text("ok"));
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "first");
    await drain();
    expect(toolResult(fake.requests[1])).toContain("The dhan service could not be reached");

    mcp.onCall = () => ({ content: [{ type: "text", text: "back" }] });
    const start = fake.requests.length;
    fake.handler = (_, index) => (index === start ? toolUse("run_python", { code: "2" }) : text("ok"));
    await send(ref, "second");
    await drain();
    expect(mcp.methods.filter((m) => m === "initialize")).toHaveLength(2);
    expect(toolResult(fake.requests.at(-1)!)).toContain("back");
  });

  it("keeps the chat working when a server is down, without its tools", async () => {
    useServers({ dhan: { url: "http://127.0.0.1:9/mcp" } });
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "hello");
    await drain(15_000);

    expect(toolNames(0)).toEqual(["search_messages", "read_messages_around", "reply_to_message"]);
    expect(systemText(fake.requests[0])).not.toContain("Connected services");
    expect((await rows(ref)).at(-1)!.content).toBe("ok");
  });

  it("puts the server name in front of a tool that clashes with a built-in", async () => {
    useServers({ dhan: { url: mcp.url } });
    mcp.tools.push({ name: "search_messages", description: "Search email.", inputSchema: { type: "object" } });
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "hello");
    await drain();

    expect(toolNames(0)).toEqual([
      "search_messages",
      "read_messages_around",
      "reply_to_message",
      "run_python",
      "dhan__search_messages",
    ]);
  });
});

describe("skills", () => {
  it("lists each skill by name and description, not its instructions", async () => {
    useSkills({ markets: SKILL });
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "hello");
    await drain();

    const system = systemText(fake.requests[0]);
    expect(system).toContain("- markets: Indian market data through run_python.");
    expect(system).not.toContain("import slashdhan");
    expect(toolNames(0)).toContain("load_skill");
  });

  it("loads a skill for the turn, but stores a stub so later windows stay small", async () => {
    useSkills({ markets: SKILL });
    fake.handler = (_, index) => (index === 0 ? toolUse("load_skill", { name: "markets" }) : text("loaded"));
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "nifty?");
    await drain();
    expect(toolResult(fake.requests[1])).toContain("import slashdhan as z");

    const [turn] = await turns(ref);
    expect(JSON.stringify(turn.transcript)).not.toContain("import slashdhan");
    expect(JSON.stringify(turn.transcript)).toContain("Skill loaded for that turn");

    fake.handler = () => text("ok");
    await send(ref, "again");
    await drain();
    expect(allText(fake.requests.at(-1)!)).not.toContain("import slashdhan");
  });

  it("tells the model which skills exist when it asks for one that doesn't", async () => {
    useSkills({ markets: SKILL });
    fake.handler = (_, index) => (index === 0 ? toolUse("load_skill", { name: "weather" }) : text("ok"));
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "weather?");
    await drain();
    expect(toolResult(fake.requests[1])).toContain("No skill named weather. Available: markets");
  });

  it("skips a skill without a valid name and description, and offers no tool when none are left", async () => {
    useSkills({ broken: "# no frontmatter", bad: "---\nname: Bad Name\ndescription: x\n---\nbody" });
    const ref = await makeUser("Acme", "Alice");
    await send(ref, "hello");
    await drain();
    expect(toolNames(0)).not.toContain("load_skill");
    expect(systemText(fake.requests[0])).not.toContain("## Skills");
  });

  it("parses frontmatter, quoted or not", () => {
    expect(parseSkill(SKILL)).toEqual({
      name: "markets",
      description: "Indian market data through run_python.",
      body: SKILL_BODY,
    });
    expect(parseSkill("no frontmatter")).toBeNull();
  });

  it("reads the skill shipped in skills/", () => {
    const skill = parseSkill(readFileSync(join("skills", "slash-markets-dhan", "SKILL.md"), "utf8"))!;
    expect(skill.name).toBe("slash-markets-dhan");
    expect(skill.description).toMatch(/^Query Indian market data from Dhan/);
    expect(skill.body).toContain("run_python");
  });
});
