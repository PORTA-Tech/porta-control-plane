import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { AuthProvider } from '@porta/api-contracts';
import { ensureFleetPersistenceReady, getFleetPersistenceMode, getFleetPool } from './fleetPersistence.js';

export type AuthRole = 'viewer' | 'operator' | 'admin' | 'auditor' | 'developer' | 'agent';
export type UserSource = 'default' | 'env' | 'custom';
export type AuthUserStatus = 'active' | 'suspended' | 'deleted';

export interface StoredAuthUserRecord {
  account_id: string;
  user_id: string;
  password_hash: string;
  password_algo: string;
  role: AuthRole;
  source: UserSource;
  display_name: string;
  avatar_url?: string;
  auth_provider?: AuthProvider | null;
  status: AuthUserStatus;
  created_at: string;
  updated_at: string;
  last_login_at?: string | null;
}

export interface CreateAuthUserRecordInput {
  account_id: string;
  user_id: string;
  password: string;
  role: AuthRole;
  source: UserSource;
  display_name: string;
  avatar_url?: string;
  auth_provider?: AuthProvider | null;
  status?: AuthUserStatus;
  created_at?: string;
  updated_at?: string;
  last_login_at?: string | null;
}

export interface UpdateAuthUserRecordInput {
  user_id: string;
  role?: AuthRole;
  source?: UserSource;
  display_name?: string;
  avatar_url?: string | null;
  auth_provider?: AuthProvider | null;
  status?: AuthUserStatus;
  updated_at?: string;
  last_login_at?: string | null;
}

export interface LegacyAuthUserImportRow {
  account_id: string;
  user_id: string;
  password: string;
  role: AuthRole;
  display_name: string;
  avatar_url?: string;
  auth_provider?: AuthProvider | null;
  source?: UserSource;
}

const scryptAsync = promisify(nodeScrypt);
const PASSWORD_ALGO = 'scrypt-v1';
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_KEY_LENGTH = 64;

interface AuthUserRow {
  account_id: string;
  user_id: string;
  password_hash: string;
  password_algo: string;
  role: AuthRole;
  source: UserSource;
  display_name: string;
  avatar_url: string | null;
  auth_provider: AuthProvider | null;
  status: AuthUserStatus;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

function normalizeUserId(userId: string): string {
  return userId.trim().toLowerCase();
}

function mapAuthUserRow(row: AuthUserRow): StoredAuthUserRecord {
  return {
    account_id: row.account_id,
    user_id: row.user_id,
    password_hash: row.password_hash,
    password_algo: row.password_algo,
    role: row.role,
    source: row.source,
    display_name: row.display_name,
    ...(row.avatar_url ? { avatar_url: row.avatar_url } : {}),
    ...(row.auth_provider ? { auth_provider: row.auth_provider } : {}),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.last_login_at ? { last_login_at: row.last_login_at } : { last_login_at: null })
  };
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const derived = await scryptAsync(password, salt, PASSWORD_KEY_LENGTH) as Buffer;
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

async function verifyPasswordHash(passwordHash: string, password: string): Promise<boolean> {
  const [saltHex, derivedHex] = passwordHash.split(':');
  if (!saltHex || !derivedHex) {
    return false;
  }

  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(derivedHex, 'hex');
  const actual = await scryptAsync(password, salt, expected.length) as Buffer;
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

export async function findAuthUserRecordByUserId(userId: string): Promise<StoredAuthUserRecord | null> {
  if (getFleetPersistenceMode() === 'memory') {
    return null;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return null;
  }

  const normalized = userId.trim();
  if (!normalized) {
    return null;
  }

  const result = await pool.query<AuthUserRow>(
    `
      SELECT
        account_id,
        user_id,
        password_hash,
        password_algo,
        role,
        source,
        display_name,
        avatar_url,
        auth_provider,
        status,
        created_at,
        updated_at,
        last_login_at
      FROM auth_users
      WHERE LOWER(user_id) = LOWER($1)
      LIMIT 1;
    `,
    [normalized]
  );

  return result.rows[0] ? mapAuthUserRow(result.rows[0]) : null;
}

export async function listAuthUserRecords(): Promise<StoredAuthUserRecord[]> {
  if (getFleetPersistenceMode() === 'memory') {
    return [];
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return [];
  }

  const result = await pool.query<AuthUserRow>(
    `
      SELECT
        account_id,
        user_id,
        password_hash,
        password_algo,
        role,
        source,
        display_name,
        avatar_url,
        auth_provider,
        status,
        created_at,
        updated_at,
        last_login_at
      FROM auth_users
      ORDER BY created_at ASC, account_id ASC;
    `
  );

  return result.rows.map(mapAuthUserRow);
}

export async function createAuthUserRecord(input: CreateAuthUserRecordInput): Promise<StoredAuthUserRecord | null> {
  if (getFleetPersistenceMode() === 'memory') {
    return null;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return null;
  }

  const timestamp = input.created_at ?? new Date().toISOString();
  const updatedAt = input.updated_at ?? timestamp;
  const passwordHash = await hashPassword(input.password);
  const result = await pool.query<AuthUserRow>(
    `
      INSERT INTO auth_users (
        account_id,
        user_id,
        password_hash,
        password_algo,
        role,
        source,
        display_name,
        avatar_url,
        auth_provider,
        status,
        created_at,
        updated_at,
        last_login_at
      ) VALUES (
        $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12::timestamptz, $13::timestamptz
      )
      RETURNING
        account_id,
        user_id,
        password_hash,
        password_algo,
        role,
        source,
        display_name,
        avatar_url,
        auth_provider,
        status,
        created_at,
        updated_at,
        last_login_at;
    `,
    [
      input.account_id,
      input.user_id,
      passwordHash,
      PASSWORD_ALGO,
      input.role,
      input.source,
      input.display_name,
      input.avatar_url ?? null,
      input.auth_provider ?? null,
      input.status ?? 'active',
      timestamp,
      updatedAt,
      input.last_login_at ?? null
    ]
  );

  return result.rows[0] ? mapAuthUserRow(result.rows[0]) : null;
}

export async function updateAuthUserRecord(input: UpdateAuthUserRecordInput): Promise<StoredAuthUserRecord | null> {
  if (getFleetPersistenceMode() === 'memory') {
    return null;
  }

  const existing = await findAuthUserRecordByUserId(input.user_id);
  if (!existing) {
    return null;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return null;
  }

  const updatedAt = input.updated_at ?? new Date().toISOString();
  const result = await pool.query<AuthUserRow>(
    `
      UPDATE auth_users
      SET
        role = $2,
        source = $3,
        display_name = $4,
        avatar_url = $5,
        auth_provider = $6,
        status = $7,
        updated_at = $8::timestamptz,
        last_login_at = $9::timestamptz
      WHERE LOWER(user_id) = LOWER($1)
      RETURNING
        account_id,
        user_id,
        password_hash,
        password_algo,
        role,
        source,
        display_name,
        avatar_url,
        auth_provider,
        status,
        created_at,
        updated_at,
        last_login_at;
    `,
    [
      input.user_id,
      input.role ?? existing.role,
      input.source ?? existing.source,
      input.display_name ?? existing.display_name,
      input.avatar_url === undefined ? existing.avatar_url ?? null : input.avatar_url,
      input.auth_provider === undefined ? existing.auth_provider ?? null : input.auth_provider,
      input.status ?? existing.status,
      updatedAt,
      input.last_login_at === undefined ? existing.last_login_at ?? null : input.last_login_at
    ]
  );

  return result.rows[0] ? mapAuthUserRow(result.rows[0]) : null;
}

export async function updateAuthUserPasswordRecord(userId: string, newPassword: string): Promise<boolean> {
  if (getFleetPersistenceMode() === 'memory') {
    return false;
  }

  const existing = await findAuthUserRecordByUserId(userId);
  if (!existing) {
    return false;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return false;
  }

  const passwordHash = await hashPassword(newPassword);
  const result = await pool.query(
    `
      UPDATE auth_users
      SET
        password_hash = $2,
        password_algo = $3,
        updated_at = $4::timestamptz
      WHERE LOWER(user_id) = LOWER($1);
    `,
    [userId, passwordHash, PASSWORD_ALGO, new Date().toISOString()]
  );

  return (result.rowCount ?? 0) > 0;
}

export async function verifyAuthUserPassword(userId: string, password: string): Promise<StoredAuthUserRecord | null> {
  const user = await findAuthUserRecordByUserId(userId);
  if (!user || user.status !== 'active') {
    return null;
  }

  if (user.password_algo !== PASSWORD_ALGO) {
    return null;
  }

  const verified = await verifyPasswordHash(user.password_hash, password);
  return verified ? user : null;
}

export async function importLegacyAuthUsers(rows: LegacyAuthUserImportRow[]): Promise<{ imported: number; skipped: number }> {
  if (getFleetPersistenceMode() === 'memory') {
    return { imported: 0, skipped: rows.length };
  }

  const existingUsers = await listAuthUserRecords();
  const existingByUserId = new Set(existingUsers.map((row) => normalizeUserId(row.user_id)));
  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    const normalizedUserId = normalizeUserId(row.user_id);
    if (!normalizedUserId || existingByUserId.has(normalizedUserId)) {
      skipped += 1;
      continue;
    }

    const created = await createAuthUserRecord({
      account_id: row.account_id,
      user_id: row.user_id,
      password: row.password,
      role: row.role,
      source: row.source ?? 'custom',
      display_name: row.display_name,
      ...(row.avatar_url ? { avatar_url: row.avatar_url } : {}),
      ...(row.auth_provider !== undefined ? { auth_provider: row.auth_provider } : {}),
      status: 'active'
    });

    if (created) {
      existingByUserId.add(normalizedUserId);
      imported += 1;
    } else {
      skipped += 1;
    }
  }

  return { imported, skipped };
}
