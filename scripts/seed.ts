import { Client } from "pg";

const TENANTS = [
  { name: "Acme", users: ["Alice", "Bob"] },
  { name: "Globex", users: ["Carol"] },
];

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
for (const tenant of TENANTS) {
  const existing = await client.query("SELECT id FROM tenants WHERE name = $1", [tenant.name]);
  const tenantId =
    existing.rows[0]?.id ??
    (await client.query("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [tenant.name])).rows[0].id;
  for (const name of tenant.users) {
    await client.query(
      `INSERT INTO users (tenant_id, name) SELECT $1, $2
       WHERE NOT EXISTS (SELECT 1 FROM users WHERE tenant_id = $1 AND name = $2)`,
      [tenantId, name],
    );
  }
}
await client.end();
console.log("seeded");
