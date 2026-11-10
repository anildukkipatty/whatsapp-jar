import { db } from "../core/db";

/**
 * The whitelist table: the phone numbers Jar answers on WhatsApp. It is read on
 * every incoming message, so adding or removing a number takes effect at once.
 */

export type WhitelistEntry = { phone: string; note: string | null; createdAt: Date };

/** A phone number as digits with the country code, or null if it can't be one. */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/[\s\-().+]/g, "");
  return /^[0-9]{8,15}$/.test(digits) ? digits : null;
}

/** Returns false when the number was already there (its note is then updated). */
export async function addToWhitelist(phone: string, note?: string | null): Promise<boolean> {
  const { rows } = await db().query(
    `INSERT INTO whatsapp_whitelist (phone, note) VALUES ($1, $2)
     ON CONFLICT (phone) DO UPDATE SET note = coalesce(EXCLUDED.note, whatsapp_whitelist.note)
     RETURNING (xmax = 0) AS added`,
    [phone, note?.trim() || null],
  );
  return rows[0].added;
}

export async function removeFromWhitelist(phone: string): Promise<boolean> {
  const { rowCount } = await db().query("DELETE FROM whatsapp_whitelist WHERE phone = $1", [phone]);
  return rowCount === 1;
}

export async function listWhitelist(): Promise<WhitelistEntry[]> {
  const { rows } = await db().query(
    `SELECT phone, note, created_at AS "createdAt" FROM whatsapp_whitelist ORDER BY created_at, phone`,
  );
  return rows;
}

export async function isWhitelisted(phones: string[]): Promise<boolean> {
  if (!phones.length) return false;
  const { rowCount } = await db().query("SELECT 1 FROM whatsapp_whitelist WHERE phone = ANY($1) LIMIT 1", [phones]);
  return rowCount === 1;
}

/** Adds a number only if it is new. Returns false, changing nothing, when it is already there. */
export async function createWhitelistEntry(phone: string, note?: string | null): Promise<boolean> {
  const { rowCount } = await db().query(
    "INSERT INTO whatsapp_whitelist (phone, note) VALUES ($1, $2) ON CONFLICT (phone) DO NOTHING",
    [phone, note?.trim() || null],
  );
  return rowCount === 1;
}

/** Changes an entry's number, note or both. */
export async function updateWhitelistEntry(
  phone: string,
  next: { phone: string; note?: string | null },
): Promise<"updated" | "missing" | "taken"> {
  try {
    const { rowCount } = await db().query("UPDATE whatsapp_whitelist SET phone = $2, note = $3 WHERE phone = $1", [
      phone,
      next.phone,
      next.note?.trim() || null,
    ]);
    return rowCount === 1 ? "updated" : "missing";
  } catch (error) {
    // 23505 is a unique violation: the new number already has its own entry.
    if ((error as { code?: string }).code === "23505") return "taken";
    throw error;
  }
}
