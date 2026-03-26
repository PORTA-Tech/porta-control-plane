import { ensureFleetPersistenceReady, getFleetPersistenceMode, getFleetPool } from './fleetPersistence.js';

export interface AccountActiveDayRecord {
  accountId: string;
  activityDate: string;
  firstActivityAtUtc: string;
  lastActivityAtUtc: string;
  lastMachineId?: string | null;
  sourceCount: number;
  updatedAtUtc: string;
}

export interface UpsertAccountActiveDayInput {
  accountId: string;
  activityDate: string;
  firstActivityAtUtc: string;
  lastActivityAtUtc: string;
  lastMachineId?: string | null;
  sourceCount?: number;
  updatedAtUtc?: string;
}

interface AccountActiveDayRow {
  account_id: string;
  activity_date: string;
  first_activity_at_utc: string;
  last_activity_at_utc: string;
  last_machine_id: string | null;
  source_count: number;
  updated_at_utc: string;
}

const accountActiveDayMemoryStore = new Map<string, AccountActiveDayRecord>();

function normalizeTimestamp(input: string): string {
  const parsed = Date.parse(input);
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}

function normalizeActivityDate(input: string): string {
  const trimmed = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? new Date().toISOString().slice(0, 10) : new Date(parsed).toISOString().slice(0, 10);
}

function buildMemoryKey(accountId: string, activityDate: string): string {
  return `${accountId}:${activityDate}`;
}

function compareActiveDays(left: AccountActiveDayRecord, right: AccountActiveDayRecord): number {
  const byDate = left.activityDate.localeCompare(right.activityDate);
  if (byDate !== 0) {
    return byDate;
  }
  return left.accountId.localeCompare(right.accountId);
}

function mapAccountActiveDayRow(row: AccountActiveDayRow): AccountActiveDayRecord {
  return {
    accountId: row.account_id,
    activityDate: row.activity_date,
    firstActivityAtUtc: row.first_activity_at_utc,
    lastActivityAtUtc: row.last_activity_at_utc,
    ...(row.last_machine_id ? { lastMachineId: row.last_machine_id } : { lastMachineId: null }),
    sourceCount: row.source_count,
    updatedAtUtc: row.updated_at_utc
  };
}

function mergeAccountActiveDay(
  existing: AccountActiveDayRecord | null,
  input: UpsertAccountActiveDayInput
): AccountActiveDayRecord {
  const activityDate = normalizeActivityDate(input.activityDate);
  const firstActivityAtUtc = normalizeTimestamp(input.firstActivityAtUtc);
  const lastActivityAtUtc = normalizeTimestamp(input.lastActivityAtUtc);
  const updatedAtUtc = normalizeTimestamp(input.updatedAtUtc ?? new Date().toISOString());
  const sourceIncrement = Math.max(0, Math.trunc(input.sourceCount ?? 1));

  if (!existing) {
    return {
      accountId: input.accountId,
      activityDate,
      firstActivityAtUtc,
      lastActivityAtUtc,
      ...(input.lastMachineId !== undefined ? { lastMachineId: input.lastMachineId } : {}),
      sourceCount: sourceIncrement,
      updatedAtUtc
    };
  }

  const shouldReplaceMachine = Date.parse(lastActivityAtUtc) >= Date.parse(existing.lastActivityAtUtc);
  return {
    accountId: existing.accountId,
    activityDate,
    firstActivityAtUtc: Date.parse(firstActivityAtUtc) <= Date.parse(existing.firstActivityAtUtc)
      ? firstActivityAtUtc
      : existing.firstActivityAtUtc,
    lastActivityAtUtc: Date.parse(lastActivityAtUtc) >= Date.parse(existing.lastActivityAtUtc)
      ? lastActivityAtUtc
      : existing.lastActivityAtUtc,
    ...(shouldReplaceMachine
      ? { lastMachineId: input.lastMachineId ?? existing.lastMachineId ?? null }
      : { lastMachineId: existing.lastMachineId ?? null }),
    sourceCount: existing.sourceCount + sourceIncrement,
    updatedAtUtc
  };
}

export async function getAccountActiveDay(accountId: string, activityDate: string): Promise<AccountActiveDayRecord | null> {
  const normalizedDate = normalizeActivityDate(activityDate);
  const key = buildMemoryKey(accountId, normalizedDate);

  if (getFleetPersistenceMode() === 'memory') {
    return accountActiveDayMemoryStore.get(key) ?? null;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return accountActiveDayMemoryStore.get(key) ?? null;
  }

  const result = await pool.query<AccountActiveDayRow>(
    `
      SELECT
        account_id,
        activity_date::text AS activity_date,
        first_activity_at_utc,
        last_activity_at_utc,
        last_machine_id,
        source_count,
        updated_at_utc
      FROM account_active_day
      WHERE account_id = $1::uuid
        AND activity_date = $2::date
      LIMIT 1;
    `,
    [accountId, normalizedDate]
  );

  return result.rows[0] ? mapAccountActiveDayRow(result.rows[0]) : null;
}

export async function upsertAccountActiveDay(input: UpsertAccountActiveDayInput): Promise<AccountActiveDayRecord> {
  const normalizedDate = normalizeActivityDate(input.activityDate);
  const existing = await getAccountActiveDay(input.accountId, normalizedDate);
  const merged = mergeAccountActiveDay(existing, {
    ...input,
    activityDate: normalizedDate
  });

  if (getFleetPersistenceMode() === 'memory') {
    accountActiveDayMemoryStore.set(buildMemoryKey(merged.accountId, merged.activityDate), merged);
    return merged;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    accountActiveDayMemoryStore.set(buildMemoryKey(merged.accountId, merged.activityDate), merged);
    return merged;
  }

  const result = await pool.query<AccountActiveDayRow>(
    `
      INSERT INTO account_active_day (
        account_id,
        activity_date,
        first_activity_at_utc,
        last_activity_at_utc,
        last_machine_id,
        source_count,
        updated_at_utc
      ) VALUES (
        $1::uuid, $2::date, $3::timestamptz, $4::timestamptz, $5, $6, $7::timestamptz
      )
      ON CONFLICT (account_id, activity_date) DO UPDATE SET
        first_activity_at_utc = LEAST(account_active_day.first_activity_at_utc, EXCLUDED.first_activity_at_utc),
        last_activity_at_utc = GREATEST(account_active_day.last_activity_at_utc, EXCLUDED.last_activity_at_utc),
        last_machine_id = CASE
          WHEN EXCLUDED.last_activity_at_utc >= account_active_day.last_activity_at_utc
            THEN EXCLUDED.last_machine_id
          ELSE account_active_day.last_machine_id
        END,
        source_count = account_active_day.source_count + EXCLUDED.source_count,
        updated_at_utc = EXCLUDED.updated_at_utc
      RETURNING
        account_id,
        activity_date::text AS activity_date,
        first_activity_at_utc,
        last_activity_at_utc,
        last_machine_id,
        source_count,
        updated_at_utc;
    `,
    [
      merged.accountId,
      merged.activityDate,
      merged.firstActivityAtUtc,
      merged.lastActivityAtUtc,
      merged.lastMachineId ?? null,
      Math.max(0, Math.trunc(input.sourceCount ?? 1)),
      merged.updatedAtUtc
    ]
  );

  return result.rows[0] ? mapAccountActiveDayRow(result.rows[0]) : merged;
}

export async function listAccountActiveDays(): Promise<AccountActiveDayRecord[]> {
  if (getFleetPersistenceMode() === 'memory') {
    return Array.from(accountActiveDayMemoryStore.values()).sort(compareActiveDays);
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return Array.from(accountActiveDayMemoryStore.values()).sort(compareActiveDays);
  }

  const result = await pool.query<AccountActiveDayRow>(
    `
      SELECT
        account_id,
        activity_date::text AS activity_date,
        first_activity_at_utc,
        last_activity_at_utc,
        last_machine_id,
        source_count,
        updated_at_utc
      FROM account_active_day
      ORDER BY activity_date ASC, account_id ASC;
    `
  );

  return result.rows.map(mapAccountActiveDayRow);
}

export async function listAccountActiveDaysForAccount(accountId: string): Promise<AccountActiveDayRecord[]> {
  if (getFleetPersistenceMode() === 'memory') {
    return Array.from(accountActiveDayMemoryStore.values())
      .filter((record) => record.accountId === accountId)
      .sort(compareActiveDays);
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return Array.from(accountActiveDayMemoryStore.values())
      .filter((record) => record.accountId === accountId)
      .sort(compareActiveDays);
  }

  const result = await pool.query<AccountActiveDayRow>(
    `
      SELECT
        account_id,
        activity_date::text AS activity_date,
        first_activity_at_utc,
        last_activity_at_utc,
        last_machine_id,
        source_count,
        updated_at_utc
      FROM account_active_day
      WHERE account_id = $1::uuid
      ORDER BY activity_date ASC;
    `,
    [accountId]
  );

  return result.rows.map(mapAccountActiveDayRow);
}

export function clearAccountActiveDayStoreForTests(): void {
  accountActiveDayMemoryStore.clear();
}
