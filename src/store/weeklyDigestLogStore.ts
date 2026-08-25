import { ensureFleetPersistenceReady, getFleetPersistenceMode, getFleetPool } from './fleetPersistence.js';

/**
 * The WEEKLY digest's own send log — deliberately NOT `digest_log`.
 *
 * The daily's log is keyed on (machine_id, date_local). Yadin's decision of 2026-08-25 is that the
 * weekly goes out Monday 07:00 local and Sunday's daily still sends, so the two live on different
 * days and could not collide today. Sharing the table anyway would still be wrong: the key is a
 * DATE, so any future change that put a weekly and a daily on one day would silently make one
 * suppress the other, and the failure would look like "the digest just didn't arrive".
 *
 * Keyed by the week's END date, so the row for a given week is stable no matter which day or which
 * machine actually sent it.
 */
export interface WeeklyDigestLogEntry {
  machineId: string;
  accountId: string | null;
  /** 'YYYY-MM-DD' — the Sunday the week ended on. The identity of the week. */
  weekEndLocal: string;
  trackedSeconds: number;
  fired: boolean;
  failureReason: string | null;
  sentAtUtc: string;
}

const memoryStore = new Map<string, WeeklyDigestLogEntry>();

function memKey(machineId: string, weekEndLocal: string): string {
  return `${machineId}::${weekEndLocal}`;
}

export async function appendWeeklyDigestLogEntry(entry: WeeklyDigestLogEntry): Promise<void> {
  if (getFleetPersistenceMode() === 'memory') {
    memoryStore.set(memKey(entry.machineId, entry.weekEndLocal), entry);
    return;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    memoryStore.set(memKey(entry.machineId, entry.weekEndLocal), entry);
    return;
  }

  await pool.query(
    `INSERT INTO weekly_digest_log
       (machine_id, account_id, week_end_local, tracked_seconds, fired, failure_reason, sent_at_utc)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (machine_id, week_end_local) DO UPDATE SET
       account_id      = EXCLUDED.account_id,
       tracked_seconds = EXCLUDED.tracked_seconds,
       fired           = EXCLUDED.fired,
       failure_reason  = EXCLUDED.failure_reason,
       sent_at_utc     = EXCLUDED.sent_at_utc`,
    [
      entry.machineId,
      entry.accountId,
      entry.weekEndLocal,
      entry.trackedSeconds,
      entry.fired,
      entry.failureReason,
      entry.sentAtUtc,
    ]
  );
}

/**
 * ONE weekly per ACCOUNT per week, whatever asks for it — the same rule the daily learned the hard
 * way (B1). The agent's own guard is in-memory, so a restart re-POSTs; and two linked machines on
 * one account would otherwise both send. The server is the only place that can see every sender.
 */
export async function wasWeeklyDigestSentForAccount(
  accountId: string,
  weekEndLocal: string
): Promise<boolean> {
  if (getFleetPersistenceMode() === 'memory') {
    return [...memoryStore.values()].some(
      (e) => e.accountId === accountId && e.weekEndLocal === weekEndLocal && e.fired === true
    );
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return [...memoryStore.values()].some(
      (e) => e.accountId === accountId && e.weekEndLocal === weekEndLocal && e.fired === true
    );
  }

  const result = await pool.query(
    `SELECT 1 FROM weekly_digest_log
      WHERE account_id = $1 AND week_end_local = $2 AND fired = TRUE
      LIMIT 1`,
    [accountId, weekEndLocal]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listWeeklyDigestLogEntries(limit = 100): Promise<WeeklyDigestLogEntry[]> {
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

  const result = await pool.query(
    `SELECT machine_id, account_id, week_end_local, tracked_seconds, fired, failure_reason, sent_at_utc
       FROM weekly_digest_log
      ORDER BY sent_at_utc DESC
      LIMIT $1`,
    [limit]
  );

  return result.rows.map((row: Record<string, unknown>) => ({
    machineId: String(row.machine_id),
    accountId: row.account_id === null ? null : String(row.account_id),
    weekEndLocal: String(row.week_end_local),
    trackedSeconds: Number(row.tracked_seconds ?? 0),
    fired: row.fired === true,
    failureReason: row.failure_reason === null ? null : String(row.failure_reason),
    sentAtUtc: new Date(String(row.sent_at_utc)).toISOString(),
  }));
}

/** Test seam — the memory-mode store is process-global. */
export function __resetWeeklyDigestLogForTests(): void {
  memoryStore.clear();
}
