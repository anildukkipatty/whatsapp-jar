import { db } from "@/core/db";
import { LoginButton } from "./LoginButton";

export const dynamic = "force-dynamic";

export default async function Login() {
  // The one deliberately cross-tenant query: this page is the demo user picker.
  // WhatsApp users are real people, so they are never offered here.
  const { rows } = await db().query(
    `SELECT u.id, u.name, t.name AS tenant_name
     FROM users u JOIN tenants t ON t.id = u.tenant_id
     WHERE u.whatsapp_id IS NULL
     ORDER BY t.name, u.name`,
  );
  return (
    <main className="login">
      <h1>Jar</h1>
      <p>Choose who to sign in as.</p>
      {rows.length === 0 && <p>No users yet. Run npm run db:seed.</p>}
      {rows.map((row) => (
        <LoginButton key={row.id} userId={row.id} name={row.name} tenantName={row.tenant_name} />
      ))}
    </main>
  );
}
