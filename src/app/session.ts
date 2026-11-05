import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { db } from "@/core/db";

const COOKIE = "jar_session";

export type Session = { tenantId: number; userId: number; userName: string; tenantName: string };

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET is not set");
  return value;
}

const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

/** Demo login: the cookie is signed, but anyone who can open /login can pick any user. */
export async function signIn(tenantId: number, userId: number) {
  const payload = `${tenantId}.${userId}`;
  (await cookies()).set(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function signOut() {
  (await cookies()).delete(COOKIE);
}

export async function getSession(): Promise<Session | null> {
  const value = (await cookies()).get(COOKIE)?.value;
  const [tenantId, userId, signature] = value?.split(".") ?? [];
  if (!signature) return null;
  const expected = Buffer.from(sign(`${tenantId}.${userId}`));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  const { rows } = await db().query(
    `SELECT u.tenant_id, u.id, u.name, t.name AS tenant_name
     FROM users u JOIN tenants t ON t.id = u.tenant_id
     WHERE u.tenant_id = $1 AND u.id = $2`,
    [tenantId, userId],
  );
  const row = rows[0];
  return row
    ? { tenantId: row.tenant_id, userId: row.id, userName: row.name, tenantName: row.tenant_name }
    : null;
}
