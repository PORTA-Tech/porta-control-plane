import { ensureFleetPersistenceReady, getFleetPersistenceMode, getFleetPool } from './fleetPersistence.js';

// In-memory fallback: map of "accountId::messageKey" → shownAtUtc
const memoryStore = new Map<string, Date>();

function memKey(accountId: string, messageKey: string): string {
  return `${accountId}::${messageKey}`;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Returns true if this template was shown to this account within the last 7 days.
 */
export async function wasMessageShownRecently(accountId: string, messageKey: string): Promise<boolean> {
  if (getFleetPersistenceMode() === 'memory') {
    const shownAt = memoryStore.get(memKey(accountId, messageKey));
    if (!shownAt) return false;
    return Date.now() - shownAt.getTime() < SEVEN_DAYS_MS;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    const shownAt = memoryStore.get(memKey(accountId, messageKey));
    if (!shownAt) return false;
    return Date.now() - shownAt.getTime() < SEVEN_DAYS_MS;
  }

  const result = await pool.query<{ count: string }>(
    `
      SELECT COUNT(*) as count FROM message_rotation
      WHERE account_id = $1
        AND message_key = $2
        AND shown_at_utc > NOW() - INTERVAL '7 days';
    `,
    [accountId, messageKey]
  );

  return parseInt(result.rows[0]?.count ?? '0', 10) > 0;
}

/**
 * Records that this template was shown. Purges entries older than 7 days.
 */
export async function recordMessageShown(accountId: string, messageKey: string): Promise<void> {
  if (getFleetPersistenceMode() === 'memory') {
    memoryStore.set(memKey(accountId, messageKey), new Date());
    // Purge stale entries from memory
    for (const [k, v] of memoryStore.entries()) {
      if (Date.now() - v.getTime() >= SEVEN_DAYS_MS) {
        memoryStore.delete(k);
      }
    }
    return;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    memoryStore.set(memKey(accountId, messageKey), new Date());
    return;
  }

  // Purge old entries and upsert new record atomically
  await pool.query(
    `
      DELETE FROM message_rotation
      WHERE shown_at_utc < NOW() - INTERVAL '7 days';
    `
  );

  await pool.query(
    `
      INSERT INTO message_rotation (account_id, message_key, shown_at_utc)
      VALUES ($1, $2, NOW())
      ON CONFLICT (account_id, message_key) DO UPDATE SET shown_at_utc = NOW();
    `,
    [accountId, messageKey]
  );
}
