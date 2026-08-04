import { createHash, randomUUID } from 'node:crypto';
import type { AuthProvider } from '@porta/api-contracts';
import type { AuthRole } from './authUserStore.js';
import { ensureFleetPersistenceReady, getFleetPersistenceMode, getFleetPool } from './fleetPersistence.js';

/**
 * 'access' is a bearer token every authenticated route accepts. 'refresh' is redeemable
 * only at POST /auth/refresh and must never satisfy readAuthSession.
 */
export type AuthSessionType = 'access' | 'refresh';

export interface StoredAuthSessionRecord {
  session_id: string;
  account_id: string;
  user_id: string;
  role: AuthRole;
  display_name: string;
  avatar_url?: string;
  auth_provider?: AuthProvider | null;
  session_type: AuthSessionType;
  refresh_family_id?: string | null;
  issued_at_utc: string;
  expires_at_utc: string;
  reauth_expires_at_utc: string;
  revoked_at_utc?: string | null;
  created_at_utc: string;
  updated_at_utc: string;
}

export interface CreateAuthSessionRecordInput {
  token: string;
  account_id: string;
  user_id: string;
  role: AuthRole;
  display_name: string;
  avatar_url?: string;
  auth_provider?: AuthProvider | null;
  session_type?: AuthSessionType;
  refresh_family_id?: string | null;
  issued_at_utc: string;
  expires_at_utc: string;
  reauth_expires_at_utc: string;
}

export interface UpdateAuthSessionRecordInput {
  session_id: string;
  account_id?: string;
  role?: AuthRole;
  display_name?: string;
  avatar_url?: string | null;
  auth_provider?: AuthProvider | null;
  issued_at_utc?: string;
  expires_at_utc?: string;
  reauth_expires_at_utc?: string;
  revoked_at_utc?: string | null;
  updated_at_utc?: string;
}

interface AuthSessionRow {
  session_id: string;
  account_id: string;
  user_id: string;
  role: AuthRole;
  display_name: string;
  avatar_url: string | null;
  auth_provider: AuthProvider | null;
  session_type: AuthSessionType;
  refresh_family_id: string | null;
  issued_at_utc: string;
  expires_at_utc: string;
  reauth_expires_at_utc: string;
  revoked_at_utc: string | null;
  created_at_utc: string;
  updated_at_utc: string;
}

export function hashAuthSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function mapAuthSessionRow(row: AuthSessionRow): StoredAuthSessionRecord {
  return {
    session_id: row.session_id,
    account_id: row.account_id,
    user_id: row.user_id,
    role: row.role,
    display_name: row.display_name,
    ...(row.avatar_url ? { avatar_url: row.avatar_url } : {}),
    ...(row.auth_provider ? { auth_provider: row.auth_provider } : {}),
    // A row written before session_type existed is an access session.
    session_type: row.session_type ?? 'access',
    refresh_family_id: row.refresh_family_id ?? null,
    issued_at_utc: row.issued_at_utc,
    expires_at_utc: row.expires_at_utc,
    reauth_expires_at_utc: row.reauth_expires_at_utc,
    ...(row.revoked_at_utc ? { revoked_at_utc: row.revoked_at_utc } : { revoked_at_utc: null }),
    created_at_utc: row.created_at_utc,
    updated_at_utc: row.updated_at_utc
  };
}

export async function createAuthSessionRecord(input: CreateAuthSessionRecordInput): Promise<StoredAuthSessionRecord | null> {
  if (getFleetPersistenceMode() === 'memory') {
    return null;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return null;
  }

  const timestamp = input.issued_at_utc;
  const result = await pool.query<AuthSessionRow>(
    `
      INSERT INTO auth_sessions (
        session_id,
        token_hash,
        account_id,
        user_id,
        role,
        display_name,
        avatar_url,
        auth_provider,
        session_type,
        refresh_family_id,
        issued_at_utc,
        expires_at_utc,
        reauth_expires_at_utc,
        revoked_at_utc,
        created_at_utc,
        updated_at_utc
      ) VALUES (
        $1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10::uuid, $11::timestamptz, $12::timestamptz, $13::timestamptz, NULL, $14::timestamptz, $15::timestamptz
      )
      RETURNING
        session_id,
        account_id,
        user_id,
        role,
        display_name,
        avatar_url,
        auth_provider,
        session_type,
        refresh_family_id,
        issued_at_utc,
        expires_at_utc,
        reauth_expires_at_utc,
        revoked_at_utc,
        created_at_utc,
        updated_at_utc;
    `,
    [
      randomUUID(),
      hashAuthSessionToken(input.token),
      input.account_id,
      input.user_id,
      input.role,
      input.display_name,
      input.avatar_url ?? null,
      input.auth_provider ?? null,
      input.session_type ?? 'access',
      input.refresh_family_id ?? null,
      input.issued_at_utc,
      input.expires_at_utc,
      input.reauth_expires_at_utc,
      timestamp,
      timestamp
    ]
  );

  return result.rows[0] ? mapAuthSessionRow(result.rows[0]) : null;
}

export async function findAuthSessionRecordByToken(token: string): Promise<StoredAuthSessionRecord | null> {
  if (getFleetPersistenceMode() === 'memory') {
    return null;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return null;
  }

  const result = await pool.query<AuthSessionRow>(
    `
      SELECT
        session_id,
        account_id,
        user_id,
        role,
        display_name,
        avatar_url,
        auth_provider,
        session_type,
        refresh_family_id,
        issued_at_utc,
        expires_at_utc,
        reauth_expires_at_utc,
        revoked_at_utc,
        created_at_utc,
        updated_at_utc
      FROM auth_sessions
      WHERE token_hash = $1
      LIMIT 1;
    `,
    [hashAuthSessionToken(token)]
  );

  return result.rows[0] ? mapAuthSessionRow(result.rows[0]) : null;
}

export async function updateAuthSessionRecord(input: UpdateAuthSessionRecordInput): Promise<StoredAuthSessionRecord | null> {
  if (getFleetPersistenceMode() === 'memory') {
    return null;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return null;
  }

  const existingResult = await pool.query<AuthSessionRow>(
    `
      SELECT
        session_id,
        account_id,
        user_id,
        role,
        display_name,
        avatar_url,
        auth_provider,
        session_type,
        refresh_family_id,
        issued_at_utc,
        expires_at_utc,
        reauth_expires_at_utc,
        revoked_at_utc,
        created_at_utc,
        updated_at_utc
      FROM auth_sessions
      WHERE session_id = $1::uuid
      LIMIT 1;
    `,
    [input.session_id]
  );

  const existing = existingResult.rows[0];
  if (!existing) {
    return null;
  }

  const updatedAt = input.updated_at_utc ?? new Date().toISOString();
  const result = await pool.query<AuthSessionRow>(
    `
      UPDATE auth_sessions
      SET
        account_id = $2::uuid,
        role = $3,
        display_name = $4,
        avatar_url = $5,
        auth_provider = $6,
        issued_at_utc = $7::timestamptz,
        expires_at_utc = $8::timestamptz,
        reauth_expires_at_utc = $9::timestamptz,
        revoked_at_utc = $10::timestamptz,
        updated_at_utc = $11::timestamptz
      WHERE session_id = $1::uuid
      RETURNING
        session_id,
        account_id,
        user_id,
        role,
        display_name,
        avatar_url,
        auth_provider,
        session_type,
        refresh_family_id,
        issued_at_utc,
        expires_at_utc,
        reauth_expires_at_utc,
        revoked_at_utc,
        created_at_utc,
        updated_at_utc;
    `,
    [
      input.session_id,
      input.account_id ?? existing.account_id,
      input.role ?? existing.role,
      input.display_name ?? existing.display_name,
      input.avatar_url === undefined ? existing.avatar_url : input.avatar_url,
      input.auth_provider === undefined ? existing.auth_provider : input.auth_provider,
      input.issued_at_utc ?? existing.issued_at_utc,
      input.expires_at_utc ?? existing.expires_at_utc,
      input.reauth_expires_at_utc ?? existing.reauth_expires_at_utc,
      input.revoked_at_utc === undefined ? existing.revoked_at_utc : input.revoked_at_utc,
      updatedAt
    ]
  );

  return result.rows[0] ? mapAuthSessionRow(result.rows[0]) : null;
}

export async function revokeAuthSessionRecord(token: string, revokedAtUtc: string): Promise<boolean> {
  if (getFleetPersistenceMode() === 'memory') {
    return false;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return false;
  }

  const result = await pool.query(
    `
      UPDATE auth_sessions
      SET
        revoked_at_utc = $2::timestamptz,
        updated_at_utc = $2::timestamptz
      WHERE token_hash = $1
        AND revoked_at_utc IS NULL;
    `,
    [hashAuthSessionToken(token), revokedAtUtc]
  );

  return (result.rowCount ?? 0) > 0;
}

/**
 * Revokes every session in a refresh chain — the access tokens it minted and every
 * rotation of the refresh token itself. Called on sign-out, and on detecting that a
 * refresh token which was already rotated away has been presented again.
 */
export async function revokeAuthSessionFamilyRecords(refreshFamilyId: string, revokedAtUtc: string): Promise<number> {
  if (getFleetPersistenceMode() === 'memory') {
    return 0;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return 0;
  }

  const result = await pool.query(
    `
      UPDATE auth_sessions
      SET
        revoked_at_utc = $2::timestamptz,
        updated_at_utc = $2::timestamptz
      WHERE refresh_family_id = $1::uuid
        AND revoked_at_utc IS NULL;
    `,
    [refreshFamilyId, revokedAtUtc]
  );

  return result.rowCount ?? 0;
}
