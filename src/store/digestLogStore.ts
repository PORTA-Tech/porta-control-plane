import { ensureFleetPersistenceReady, getFleetPersistenceMode, getFleetPool } from './fleetPersistence.js';

export interface DigestLogEntry {
  machineId: string;
  accountId: string | null;
  dateLocal: string;
  trackedSeconds: number;
  fired: boolean;
  failureReason: string | null;
  sentAtUtc: string;
}

const memoryStore = new Map<string, DigestLogEntry>();

function memKey(machineId: string, dateLocal: string): string {
  return `${machineId}::${dateLocal}`;
}

export async function appendDigestLogEntry(entry: DigestLogEntry): Promise<void> {
  if (getFleetPersistenceMode() === 'memory') {
    memoryStore.set(memKey(entry.machineId, entry.dateLocal), entry);
    return;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    memoryStore.set(memKey(entry.machineId, entry.dateLocal), entry);
    return;
  }

  await pool.query(
    `INSERT INTO digest_log
       (machine_id, account_id, date_local, tracked_seconds, fired, failure_reason, sent_at_utc)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (machine_id, date_local) DO UPDATE SET
       account_id      = EXCLUDED.account_id,
       tracked_seconds = EXCLUDED.tracked_seconds,
       fired           = EXCLUDED.fired,
       failure_reason  = EXCLUDED.failure_reason,
       sent_at_utc     = EXCLUDED.sent_at_utc`,
    [
      entry.machineId,
      entry.accountId,
      entry.dateLocal,
      entry.trackedSeconds,
      entry.fired,
      entry.failureReason,
      entry.sentAtUtc,
    ]
  );
}

export async function listDigestLogEntries(limit = 100): Promise<DigestLogEntry[]> {
  if (getFleetPersistenceMode() === 'memory') {
    return [...memoryStore.values()]
      .sort((a, b) => b.sentAtUtc.localeCompare(a.sentAtUtc))
      .slice(0, limit);
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return [...memoryStore.values()]
      .sort((a, b) => b.sentAtUtc.localeCompare(a.sentAtUtc))
      .slice(0, limit);
  }

  const result = await pool.query<{
    machine_id: string;
    account_id: string | null;
    date_local: string;
    tracked_seconds: number;
    fired: boolean;
    failure_reason: string | null;
    sent_at_utc: Date | string;
  }>(
    `SELECT machine_id, account_id, date_local, tracked_seconds, fired, failure_reason, sent_at_utc
     FROM digest_log
     ORDER BY sent_at_utc DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows.map((row) => ({
    machineId: row.machine_id,
    accountId: row.account_id,
    dateLocal: row.date_local,
    trackedSeconds: row.tracked_seconds,
    fired: row.fired,
    failureReason: row.failure_reason,
    sentAtUtc: row.sent_at_utc instanceof Date ? row.sent_at_utc.toISOString() : String(row.sent_at_utc),
  }));
}

/**
 * Returns true if a digest email was already sent for the given account on the given local date.
 * Used by the server-side cron to skip accounts whose machines already sent the email at 19:30 UTC.
 */
export async function wasDigestSentForAccount(accountId: string, dateLocal: string): Promise<boolean> {
  if (getFleetPersistenceMode() === 'memory') {
    return Array.from(memoryStore.values()).some(
      e => e.accountId === accountId && e.dateLocal === dateLocal && e.fired === true
    );
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return Array.from(memoryStore.values()).some(
      e => e.accountId === accountId && e.dateLocal === dateLocal && e.fired === true
    );
  }

  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM digest_log
       WHERE account_id = $1 AND date_local = $2 AND fired = true
     ) AS exists`,
    [accountId, dateLocal]
  );

  return result.rows[0]?.exists === true;
}
