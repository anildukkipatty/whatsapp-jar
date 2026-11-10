import { createAdminServer } from "./admin";

/** The whitelist page as its own process: npm run admin. */

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
const token = process.env.ADMIN_TOKEN?.trim();
if (!token) throw new Error("ADMIN_TOKEN is not set. Generate one with: openssl rand -hex 24");

const port = Number(process.env.ADMIN_PORT) || 8080;
const server = createAdminServer(token);
server.listen(port, () => console.log(`[admin] whitelist page is on port ${port}, at /whitelist/<ADMIN_TOKEN>`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
