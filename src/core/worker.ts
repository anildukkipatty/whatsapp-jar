import { randomUUID } from "node:crypto";
import { config } from "./config";
import { db } from "./db";
import { processThread, type ThreadJob } from "./turn";

/**
 * Finds threads with a debounced batch ready. All state is in Postgres, so this
 * survives restarts and any number of workers can run: the lease decides who
 * gets a thread.
 */
async function findDueThreads(limit: number) {
  const { rows } = await db().query(
    `SELECT t.id, t.tenant_id, t.attempts, u.name, u.timezone
     FROM (
       SELECT thread_id, min(created_at) AS oldest
       FROM messages WHERE role = 'user' AND turn_id IS NULL
       GROUP BY thread_id
       HAVING max(created_at) <= now() - $1 * interval '1 millisecond'
           OR min(created_at) <= now() - $2 * interval '1 millisecond'
     ) inbox
     JOIN threads t ON t.id = inbox.thread_id
     JOIN users u ON u.tenant_id = t.tenant_id AND u.id = t.user_id
     WHERE (t.lease_expires_at IS NULL OR t.lease_expires_at < now())
       AND (t.retry_at IS NULL OR t.retry_at <= now())
     ORDER BY inbox.oldest
     LIMIT $3`,
    [config.debounceMs, config.debounceMaxMs, limit],
  );
  return rows;
}

async function acquireLease(tenantId: number, threadId: number, owner: string) {
  const { rowCount } = await db().query(
    `UPDATE threads SET lease_owner = $3, lease_expires_at = now() + $4 * interval '1 millisecond'
     WHERE tenant_id = $1 AND id = $2 AND (lease_expires_at IS NULL OR lease_expires_at < now())`,
    [tenantId, threadId, owner, config.leaseMs],
  );
  return rowCount === 1;
}

async function renewLease(job: ThreadJob) {
  const { rowCount } = await db().query(
    `UPDATE threads SET lease_expires_at = now() + $4 * interval '1 millisecond'
     WHERE tenant_id = $1 AND id = $2 AND lease_owner = $3`,
    [job.tenantId, job.threadId, job.leaseOwner, config.leaseMs],
  );
  return rowCount === 1;
}

async function releaseLease(job: ThreadJob, retryInMs?: number) {
  await db().query(
    `UPDATE threads
     SET lease_owner = NULL, lease_expires_at = NULL,
         attempts = CASE WHEN $4::int IS NULL THEN attempts ELSE attempts + 1 END,
         retry_at = CASE WHEN $4::int IS NULL THEN retry_at ELSE now() + $4 * interval '1 millisecond' END
     WHERE tenant_id = $1 AND id = $2 AND lease_owner = $3`,
    [job.tenantId, job.threadId, job.leaseOwner, retryInMs ?? null],
  );
}

async function runLeased(job: ThreadJob) {
  const abort = new AbortController();
  const heartbeat = setInterval(() => {
    renewLease(job)
      .then((held) => held || abort.abort())
      .catch((error) => console.error("[worker] lease renewal failed:", error));
  }, config.leaseMs / 3);
  let retryInMs: number | undefined;
  try {
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(config.turnTimeoutMs)]);
    ({ retryInMs } = await processThread(job, signal));
  } catch (error) {
    // Lost lease or a database failure. Nothing was committed, so the inbox is intact.
    console.error(`[worker] thread ${job.threadId} turn abandoned:`, error);
    retryInMs = config.retryBaseMs;
  } finally {
    clearInterval(heartbeat);
    await releaseLease(job, retryInMs).catch((error) => console.error("[worker] release failed:", error));
  }
}

const running = new Set<Promise<void>>();

/** One scheduling pass. Starts turns and returns without waiting for them. */
export async function tick() {
  const free = config.maxConcurrentTurns - running.size;
  if (free <= 0) return;
  for (const row of await findDueThreads(free)) {
    const leaseOwner = randomUUID();
    if (!(await acquireLease(row.tenant_id, row.id, leaseOwner))) continue;
    const turn = runLeased({
      tenantId: row.tenant_id,
      threadId: row.id,
      attempts: row.attempts,
      leaseOwner,
      userName: row.name,
      timeZone: row.timezone,
    }).finally(() => running.delete(turn));
    running.add(turn);
  }
}

/** Resolves when every turn started by this process has finished. */
export async function idle() {
  while (running.size) await Promise.all(running);
}

const globals = globalThis as unknown as { jarWorker?: NodeJS.Timeout };

export function startWorker() {
  if (globals.jarWorker) return;
  const loop = async () => {
    await tick().catch((error) => console.error("[worker] tick failed:", error));
    globals.jarWorker = setTimeout(loop, config.pollMs);
  };
  globals.jarWorker = setTimeout(loop, 0);
}
