import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAdminServer } from "../src/whatsapp/admin";
import { handleIncoming, type Sender } from "../src/whatsapp/gateway";
import { resetDb } from "./harness";

const TOKEN = "test-token-0123456789abcdef-0123";
let server: Server;
let base = "";

beforeAll(async () => {
  server = createAdminServer(TOKEN);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => resetDb());

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${base}/whitelist/${TOKEN}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
const phones = async () =>
  ((await (await call("GET", "/api/numbers")).json()) as { phone: string; note: string | null }[]).map((e) => [
    e.phone,
    e.note,
  ]);

describe("whitelist page", () => {
  it("serves the page only at the secret link", async () => {
    const page = await call("GET", "");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Jar whitelist");

    for (const path of ["/", "/whitelist", "/whitelist/", "/whitelist/wrong-token", "/whitelist/wrong-token/api/numbers"]) {
      const response = await fetch(base + path);
      expect(response.status, path).toBe(404);
      expect(await response.text()).toBe("");
    }
  });

  it("adds, lists, edits and deletes numbers", async () => {
    expect((await call("POST", "/api/numbers", { phone: "+91 98765-43210", note: " Ravi " })).status).toBe(201);
    expect((await call("POST", "/api/numbers", { phone: "919000000002" })).status).toBe(201);
    expect(await phones()).toEqual([
      ["919876543210", "Ravi"],
      ["919000000002", null],
    ]);

    // Edit the note only, then the number.
    expect((await call("PUT", "/api/numbers/919876543210", { phone: "919876543210", note: "Ravi K" })).status).toBe(200);
    expect((await call("PUT", "/api/numbers/919000000002", { phone: "919000000003", note: "" })).status).toBe(200);
    expect(await phones()).toEqual([
      ["919876543210", "Ravi K"],
      ["919000000003", null],
    ]);

    expect((await call("DELETE", "/api/numbers/919876543210")).status).toBe(204);
    expect(await phones()).toEqual([["919000000003", null]]);
  });

  it("explains mistakes instead of saving them", async () => {
    await call("POST", "/api/numbers", { phone: "919876543210", note: "Ravi" });
    await call("POST", "/api/numbers", { phone: "919000000002" });

    const duplicate = await call("POST", "/api/numbers", { phone: "919876543210", note: "someone else" });
    expect(duplicate.status).toBe(409);
    const noCountryCode = await call("POST", "/api/numbers", { phone: "9876543210" });
    expect(noCountryCode.status).toBe(400);
    expect(((await noCountryCode.json()) as { error: string }).error).toContain("919876543210");
    expect((await call("POST", "/api/numbers", { phone: "not a number" })).status).toBe(400);
    expect((await call("POST", "/api/numbers", { phone: "919000000009", note: "x".repeat(101) })).status).toBe(400);

    // Editing onto another entry's number, or an entry that is gone.
    expect((await call("PUT", "/api/numbers/919000000002", { phone: "919876543210" })).status).toBe(409);
    expect((await call("PUT", "/api/numbers/919000000007", { phone: "919000000008" })).status).toBe(404);
    expect((await call("DELETE", "/api/numbers/919000000007")).status).toBe(404);

    expect(await phones()).toEqual([
      ["919876543210", "Ravi"],
      ["919000000002", null],
    ]);
  });

  it("decides who the WhatsApp channel answers", async () => {
    process.env.WHATSAPP_OPEN = "false";
    delete process.env.WHATSAPP_ALLOWED_NUMBERS;
    const sender: Sender = { send: async () => null };
    const message = (id: string) => ({
      id,
      chatId: "919876543210@c.us",
      fromMe: false,
      isGroup: false,
      type: "chat",
      text: "hi",
    });

    expect(await handleIncoming(message("a"), sender)).toBe("ignored");
    await call("POST", "/api/numbers", { phone: "919876543210" });
    expect(await handleIncoming(message("b"), sender)).toBe("accepted");
    await call("DELETE", "/api/numbers/919876543210");
    expect(await handleIncoming(message("c"), sender)).toBe("ignored");
  });

  it("refuses a short token", () => {
    expect(() => createAdminServer("short")).toThrow();
  });
});
