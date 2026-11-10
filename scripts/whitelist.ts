import { db } from "../src/core/db";
import { addToWhitelist, listWhitelist, normalizePhone, removeFromWhitelist } from "../src/whatsapp/whitelist";

/**
 * Manages the numbers Jar answers on WhatsApp. No restart is needed afterwards.
 *
 *   npm run whitelist -- add 910000000000 "Test user"
 *   npm run whitelist -- remove 910000000000
 *   npm run whitelist -- list
 */

const USAGE = `Usage:
  npm run whitelist -- add <number> [note]    number with country code, e.g. 910000000000
  npm run whitelist -- remove <number>
  npm run whitelist -- list`;

function phoneArg(raw: string | undefined) {
  const phone = raw && normalizePhone(raw);
  if (!phone) {
    console.error(`"${raw ?? ""}" is not a phone number. Give it in digits with the country code, e.g. 910000000000.`);
    process.exit(1);
  }
  if (phone.length <= 10) {
    console.warn(`Warning: ${phone} has only ${phone.length} digits. Without the country code (91 for India) it will never match.`);
  }
  return phone;
}

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
const [command, number, ...note] = process.argv.slice(2);

if (command === "add") {
  const phone = phoneArg(number);
  const added = await addToWhitelist(phone, note.join(" "));
  console.log(added ? `Added ${phone}. Jar answers this number from now on.` : `${phone} was already whitelisted.`);
} else if (command === "remove") {
  const phone = phoneArg(number);
  const removed = await removeFromWhitelist(phone);
  console.log(removed ? `Removed ${phone}. Jar no longer answers this number.` : `${phone} was not in the whitelist.`);
} else if (command === "list") {
  const entries = await listWhitelist();
  if (!entries.length) console.log("The whitelist is empty.");
  for (const entry of entries) {
    console.log(`${entry.phone}  ${entry.createdAt.toISOString().slice(0, 10)}  ${entry.note ?? ""}`.trimEnd());
  }
} else {
  console.error(USAGE);
  process.exitCode = 1;
}
await db().end();
