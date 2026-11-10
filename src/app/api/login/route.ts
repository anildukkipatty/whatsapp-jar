import { db } from "@/core/db";
import { z } from "zod";
import { signIn } from "../../session";

const Body = z.object({ userId: z.number().int(), timeZone: z.string().max(64) });

function validTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

export async function POST(request: Request) {
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Invalid request" }, { status: 400 });

  const { rows } = await db().query(
    "UPDATE users SET timezone = $2 WHERE id = $1 AND whatsapp_id IS NULL RETURNING tenant_id, id",
    [body.data.userId, validTimeZone(body.data.timeZone)],
  );
  if (!rows[0]) return Response.json({ error: "Unknown user" }, { status: 404 });
  await signIn(rows[0].tenant_id, rows[0].id);
  return Response.json({ ok: true });
}
