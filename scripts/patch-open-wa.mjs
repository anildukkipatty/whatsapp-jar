// Repairs @open-wa/core 5.10.0 after every install (it runs as "postinstall").
//
// 1. The fix. open-wa saves the WhatsApp login to .whatsapp-session/ and loads it
//    back at the next start. Loading calls WhatsApp Web's `setMe`, which WhatsApp
//    renamed to `setMePn`. The call throws, open-wa reports the vague
//    SESSION_RESTORE_UNAVAILABLE, deletes the saved login and asks for a new QR
//    scan on every restart. The patch calls whichever of the two names exists.
// 2. A log line. open-wa keeps the real reason for a failed restore inside the
//    browser page and never logs it. With this it is logged as
//    `portable_session_bootstrap_diagnostic`, so the next rename by WhatsApp can
//    be found in minutes.
//
// The file being patched is obfuscated, so the patch is tied to this exact
// version. On any other version it changes nothing and says so: check then
// whether a restart still keeps the WhatsApp link, and delete this script if so.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "5.10.0";
const core = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@open-wa", "core");

let installed;
try {
  installed = JSON.parse(readFileSync(join(core, "package.json"), "utf8")).version;
} catch {
  console.log("[patch-open-wa] @open-wa/core is not installed, nothing to patch");
  process.exit(0);
}
if (installed !== VERSION) {
  console.warn(
    `[patch-open-wa] @open-wa/core is ${installed}, but this patch is for ${VERSION}. Nothing was patched. ` +
      "Test that a restart keeps the WhatsApp link, then update or delete scripts/patch-open-wa.mjs.",
  );
  process.exit(0);
}

function patch(file, from, to) {
  const path = join(core, "dist", file);
  const source = readFileSync(path, "utf8");
  if (source.includes(to)) return console.log(`[patch-open-wa] ${file}: already patched`);
  if (source.split(from).length !== 2) {
    console.error(`[patch-open-wa] ${file}: the code to patch was not found exactly once. Nothing was changed in it.`);
    process.exitCode = 1;
    return;
  }
  writeFileSync(path, source.replace(from, () => to));
  console.log(`[patch-open-wa] ${file}: patched`);
}

patch(
  "transport/assets/pre_init.js",
  "_0x56aad0[_0xb02377(0x58b,'P8@t')](_0x1cb772)",
  "(_0x56aad0['setMePn']||_0x56aad0['setMe'])(_0x1cb772)",
);

const failed = `this.logger.warn("portable_session_bootstrap_failed", { code: /^[A-Z_]+$/.test(portableFailure) ? portableFailure : "SESSION_STARTUP_FAILED" });`;
const diagnostic = `this.logger.warn("portable_session_bootstrap_diagnostic", { diagnostic: await this.page.evaluateScript("JSON.stringify(globalThis.OpenWA_PortableSession?.startupDiagnostic?.() ?? null)").catch((error) => String(error)) });`;
for (const file of ["index.mjs", "index.cjs"]) patch(file, failed, `${failed}\n\t\t\t${diagnostic}`);
