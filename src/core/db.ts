import pg from "pg";

// bigint ids stay far below 2^53, so plain numbers are safe and simpler than strings.
pg.types.setTypeParser(pg.types.builtins.INT8, Number);

const globals = globalThis as unknown as { jarPool?: pg.Pool };

export function db() {
  globals.jarPool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
  return globals.jarPool;
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
