import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

/** Applies each db/migrations/*.sql file once, in filename order. */
export async function migrate(databaseUrl: string) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const dir = join(import.meta.dirname, "..", "db", "migrations");
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      const done = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
      if (done.rowCount) continue;
      await client.query("BEGIN");
      await client.query(readFileSync(join(dir, name), "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      console.log(`applied ${name}`);
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] === import.meta.filename) {
  await migrate(process.env.DATABASE_URL!);
}
