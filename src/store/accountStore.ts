import type { AccountProfile } from '@porta/api-contracts';
import { ensureFleetPersistenceReady, getFleetPersistenceMode, getFleetPool } from './fleetPersistence.js';

const accountMemoryStore = new Map<string, AccountProfile>();

function normalizeTimestamp(input: string): string {
  const parsed = Date.parse(input);
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}

export async function upsertAccountProfile(profile: AccountProfile): Promise<void> {
  if (getFleetPersistenceMode() === 'memory') {
    accountMemoryStore.set(profile.accountId, profile);
    return;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    accountMemoryStore.set(profile.accountId, profile);
    return;
  }

  await pool.query(
    `
      INSERT INTO accounts (
        account_id,
        primary_email,
        display_name,
        email_verified,
        status,
        auth_provider,
        last_login_at,
        payload_json,
        created_at,
        updated_at
      ) VALUES (
        $1::uuid, $2, $3, $4, $5, $6, $7::timestamptz, $8::jsonb, $9::timestamptz, $10::timestamptz
      )
      ON CONFLICT (account_id) DO UPDATE SET
        primary_email = EXCLUDED.primary_email,
        display_name = EXCLUDED.display_name,
        email_verified = EXCLUDED.email_verified,
        status = EXCLUDED.status,
        auth_provider = EXCLUDED.auth_provider,
        last_login_at = EXCLUDED.last_login_at,
        payload_json = EXCLUDED.payload_json,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at;
    `,
    [
      profile.accountId,
      profile.primaryEmail,
      profile.displayName,
      profile.emailVerified,
      profile.status,
      profile.authProvider ?? null,
      profile.lastLoginAt ?? null,
      JSON.stringify(profile),
      profile.createdAt,
      profile.updatedAt
    ]
  );
}

export async function getAccountProfile(accountId: string): Promise<AccountProfile | null> {
  if (getFleetPersistenceMode() === 'memory') {
    return accountMemoryStore.get(accountId) ?? null;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return accountMemoryStore.get(accountId) ?? null;
  }

  const result = await pool.query<{ payload_json: AccountProfile }>(
    `
      SELECT payload_json
      FROM accounts
      WHERE account_id = $1::uuid
      LIMIT 1;
    `,
    [accountId]
  );

  return result.rows[0]?.payload_json ?? null;
}

export async function getAccountProfileByPrimaryEmail(primaryEmail: string): Promise<AccountProfile | null> {
  if (getFleetPersistenceMode() === 'memory') {
    return Array.from(accountMemoryStore.values()).find((profile) => profile.primaryEmail === primaryEmail) ?? null;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return Array.from(accountMemoryStore.values()).find((profile) => profile.primaryEmail === primaryEmail) ?? null;
  }

  const result = await pool.query<{ payload_json: AccountProfile }>(
    `
      SELECT payload_json
      FROM accounts
      WHERE primary_email = $1
      LIMIT 1;
    `,
    [primaryEmail]
  );

  return result.rows[0]?.payload_json ?? null;
}

export async function touchAccountLastLogin(accountId: string, atUtc: string): Promise<AccountProfile | null> {
  const timestamp = normalizeTimestamp(atUtc);

  if (getFleetPersistenceMode() === 'memory') {
    const existing = accountMemoryStore.get(accountId);
    if (!existing) {
      return null;
    }

    const updated: AccountProfile = {
      ...existing,
      lastLoginAt: timestamp,
      updatedAt: timestamp
    };
    accountMemoryStore.set(accountId, updated);
    return updated;
  }

  const existing = await getAccountProfile(accountId);
  if (!existing) {
    return null;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    const updated: AccountProfile = {
      ...existing,
      lastLoginAt: timestamp,
      updatedAt: timestamp
    };
    accountMemoryStore.set(accountId, updated);
    return updated;
  }

  const updated: AccountProfile = {
    ...existing,
    lastLoginAt: timestamp,
    updatedAt: timestamp
  };

  const result = await pool.query<{ payload_json: AccountProfile }>(
    `
      UPDATE accounts
      SET
        last_login_at = $2::timestamptz,
        payload_json = $3::jsonb,
        updated_at = $4::timestamptz
      WHERE account_id = $1::uuid
      RETURNING payload_json;
    `,
    [
      accountId,
      timestamp,
      JSON.stringify(updated),
      timestamp
    ]
  );

  return result.rows[0]?.payload_json ?? updated;
}

export async function listAccountProfiles(): Promise<AccountProfile[]> {
  if (getFleetPersistenceMode() === 'memory') {
    return Array.from(accountMemoryStore.values()).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return Array.from(accountMemoryStore.values()).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  const result = await pool.query<{ payload_json: AccountProfile }>(
    `
      SELECT payload_json
      FROM accounts
      ORDER BY updated_at DESC, account_id ASC;
    `
  );

  return result.rows.map((row) => row.payload_json);
}

export async function deleteAccountProfile(accountId: string): Promise<void> {
  if (getFleetPersistenceMode() === 'memory') {
    accountMemoryStore.delete(accountId);
    return;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    accountMemoryStore.delete(accountId);
    return;
  }

  await pool.query(
    `
      DELETE FROM accounts
      WHERE account_id = $1::uuid;
    `,
    [accountId]
  );
}

export function clearAccountStoreForTests(): void {
  accountMemoryStore.clear();
}
