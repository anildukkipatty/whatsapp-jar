import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ADMIN_PAGE } from "./admin-page";
import {
  createWhitelistEntry,
  listWhitelist,
  normalizePhone,
  removeFromWhitelist,
  updateWhitelistEntry,
} from "./whitelist";

/**
 * A small web page for managing the WhatsApp whitelist, for someone who has no
 * access to the server. There is no login: the page lives at /whitelist/<token>,
 * and whoever has that link can use it. Every other path answers 404.
 *
 * It is a separate process from the WhatsApp one, so it can be restarted
 * without touching the WhatsApp link.
 */

const MAX_BODY_BYTES = 10_000;
const MAX_NOTE_CHARS = 100;

class BadRequest extends Error {}

function sameToken(given: string, expected: string) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BadRequest("That is too much text.");
    chunks.push(chunk);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // Falls through to the error below.
  }
  throw new BadRequest("The request could not be read.");
}

/** The person using the page types numbers by hand, so mistakes get a plain explanation. */
function readEntry(body: Record<string, unknown>) {
  const phone = normalizePhone(typeof body.phone === "string" ? body.phone : "");
  if (!phone) throw new BadRequest("Enter the phone number in digits, with the country code. Example: 919876543210");
  if (phone.length <= 10) {
    throw new BadRequest(`${phone} is missing its country code. For an Indian number, put 91 in front: 91${phone}`);
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > MAX_NOTE_CHARS) throw new BadRequest(`Keep the name or note under ${MAX_NOTE_CHARS} characters.`);
  return { phone, note: note || null };
}

function send(res: ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

async function api(req: IncomingMessage, res: ServerResponse, rest: string) {
  const target = rest.match(/^\/api\/numbers(?:\/([0-9]{8,15}))?$/);
  if (!target) return send(res, 404, { error: "Not found." });
  const phone = target[1];

  if (!phone && req.method === "GET") return send(res, 200, await listWhitelist());
  if (!phone && req.method === "POST") {
    const entry = readEntry(await readJson(req));
    if (!(await createWhitelistEntry(entry.phone, entry.note))) {
      return send(res, 409, { error: `${entry.phone} is already in the list.` });
    }
    return send(res, 201, entry);
  }
  if (phone && req.method === "PUT") {
    const entry = readEntry(await readJson(req));
    const outcome = await updateWhitelistEntry(phone, entry);
    if (outcome === "missing") return send(res, 404, { error: `${phone} is no longer in the list.` });
    if (outcome === "taken") return send(res, 409, { error: `${entry.phone} is already in the list.` });
    return send(res, 200, entry);
  }
  if (phone && req.method === "DELETE") {
    if (!(await removeFromWhitelist(phone))) return send(res, 404, { error: `${phone} is no longer in the list.` });
    return send(res, 204);
  }
  return send(res, 405, { error: "Not allowed." });
}

export function createAdminServer(token: string) {
  if (token.length < 24) throw new Error("The admin token must be at least 24 characters, because it is the only lock");
  const prefix = "/whitelist/";

  return createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-robots-tag", "noindex, nofollow");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    try {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      const [given = "", ...restParts] = path.startsWith(prefix) ? path.slice(prefix.length).split("/") : [];
      if (!given || !sameToken(given, token)) return res.writeHead(404).end();
      const rest = restParts.length ? `/${restParts.join("/")}` : "";

      if (rest === "" || rest === "/") {
        if (req.method !== "GET") return res.writeHead(405).end();
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
        });
        return res.end(ADMIN_PAGE);
      }
      await api(req, res, rest);
    } catch (error) {
      if (error instanceof BadRequest) return send(res, 400, { error: error.message });
      console.error("[admin] request failed:", error);
      if (!res.headersSent) send(res, 500, { error: "Something went wrong. Please try again." });
      else res.end();
    }
  });
}
