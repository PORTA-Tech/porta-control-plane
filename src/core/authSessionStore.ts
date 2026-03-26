import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AuthProvider } from '@porta/api-contracts';
import {
  createAuthUserRecord,
  findAuthUserRecordByUserId,
  importLegacyAuthUsers,
  listAuthUserRecords,
  updateAuthUserPasswordRecord,
  updateAuthUserRecord,
  verifyAuthUserPassword,
  type AuthRole,
  type LegacyAuthUserImportRow,
  type StoredAuthUserRecord,
  type UserSource
} from '../store/authUserStore.js';
import {
  createAuthSessionRecord,
  findAuthSessionRecordByToken,
  revokeAuthSessionRecord,
  updateAuthSessionRecord,
  type StoredAuthSessionRecord
} from '../store/authSessionDbStore.js';
import { getFleetPersistenceMode } from '../store/fleetPersistence.js';
import { consumePasswordResetCode, consumeSignupCode } from './authAccessCodeStore.js';
import { resolveAssignedRoleForUser } from './rbacStore.js';

interface LocalAuthUserRecord {
  account_id: string;
  user_id: string;
  password: string;
  role: AuthRole;
  display_name: string;
  avatar_url?: string;
  auth_provider?: AuthProvider | null;
  source: UserSource;
}

interface SessionRecord {
  token: string;
  account_id: string;
  user_id: string;
  base_role: AuthRole;
  role: AuthRole;
  display_name: string;
  avatar_url?: string;
  auth_provider?: AuthProvider | null;
  source: UserSource;
  issued_at_utc: string;
  expires_at_utc: string;
  reauth_expires_at_utc: string;
}

type AuthUserPublicView = Pick<LocalAuthUserRecord, 'account_id' | 'user_id' | 'role' | 'display_name' | 'avatar_url' | 'auth_provider'>;

interface AuthenticatedAuthUserView extends AuthUserPublicView {
  base_role: AuthRole;
  source: UserSource;
}

export interface AuthSessionView {
  account_id: string;
  user_id: string;
  role: AuthRole;
  display_name: string;
  avatar_url?: string;
  auth_provider?: AuthProvider | null;
  issued_at_utc: string;
  expires_at_utc: string;
  reauth_expires_at_utc: string;
}

export interface AuthUserIdentityView {
  account_id: string;
  user_id: string;
  role: AuthRole;
  display_name: string;
  avatar_url?: string;
  auth_provider?: AuthProvider | null;
  source: UserSource;
}

export interface AuthAccessHelpView {
  signup_enabled: boolean;
  admin_signup_enabled: boolean;
  signup_code_required: boolean;
  signup_code_length: number;
  user_id_rules: {
    pattern: string;
    min_length: number;
    max_length: number;
    example: string;
  };
  password_rules: {
    min_length: number;
    requires_upper: boolean;
    requires_lower: boolean;
    requires_number: boolean;
  };
}

const sessions = new Map<string, SessionRecord>();
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const moduleUsersPath = path.resolve(moduleDir, '..', '..', '.data', 'auth-users.json');
const legacyUsersPath = path.resolve('.data', 'auth-users.json');
const homeUsersPath = path.resolve(os.homedir(), '.porta', 'auth-users.json');
const usersPath = process.env.AUTH_USERS_PATH && process.env.AUTH_USERS_PATH.trim().length > 0
  ? path.resolve(process.env.AUTH_USERS_PATH)
  : homeUsersPath;
const USER_ID_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USER_ID_PATTERN_STRING = '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$';
const USER_ID_MIN = 5;
const USER_ID_MAX = 128;
const PASSWORD_MIN = 8;

let baseUsers: LocalAuthUserRecord[] = loadBaseUsers();
let memoryCustomUsers: LocalAuthUserRecord[] = loadCustomUsersFromFiles();
let legacyImportPromise: Promise<void> | null = null;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.trunc(parsed)) : fallback;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (typeof raw !== 'string') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return fallback;
}

function sessionTtlMinutes(): number {
  return parsePositiveInt(process.env.AUTH_SESSION_TTL_MINUTES, 30 * 24 * 60);
}

function reauthTtlMinutes(): number {
  return parsePositiveInt(process.env.AUTH_REAUTH_TTL_MINUTES, 10);
}

function allowSelfRegister(): boolean {
  return parseBoolean(process.env.AUTH_ALLOW_SELF_REGISTER, true);
}

function allowSelfRegisterAdmin(): boolean {
  return parseBoolean(process.env.AUTH_ALLOW_SELF_REGISTER_ADMIN, true);
}

function requireSignupCode(): boolean {
  return parseBoolean(process.env.AUTH_REQUIRE_SIGNUP_CODE, false);
}

// Compatibility-release toggle: allow postgres nodes to keep reading legacy
// file-backed custom users until the rollout is complete everywhere.
function allowLegacyCustomUserFallback(): boolean {
  if (getFleetPersistenceMode() !== 'postgres') {
    return true;
  }
  return parseBoolean(process.env.AUTH_COMPAT_LEGACY_USER_FALLBACK, true);
}

// Compatibility-release toggle: mirror new custom-user mutations back to the
// legacy JSON store so mixed-version nodes do not diverge during rollout.
function shouldMirrorLegacyCustomUsers(): boolean {
  if (getFleetPersistenceMode() !== 'postgres') {
    return false;
  }
  return parseBoolean(process.env.AUTH_COMPAT_DUAL_WRITE_LEGACY_USERS, true);
}

function deriveStableAccountId(userId: string): string {
  const digest = createHash('sha256').update(`porta-auth-account:${userId.trim().toLowerCase()}`).digest('hex');
  const raw = digest.slice(0, 32).split('');
  raw[12] = '4';
  const variant = parseInt(raw[16] ?? '8', 16);
  raw[16] = ((variant & 0x3) | 0x8).toString(16);
  const hex = raw.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function stableUsers(): LocalAuthUserRecord[] {
  const adminPassword = process.env.AUTH_DEFAULT_ADMIN_PASSWORD ?? 'porta-admin';
  const operatorPassword = process.env.AUTH_DEFAULT_OPERATOR_PASSWORD ?? 'porta-operator';
  const auditorPassword = process.env.AUTH_DEFAULT_AUDITOR_PASSWORD ?? 'porta-auditor';
  const developerPassword = process.env.AUTH_DEFAULT_DEVELOPER_PASSWORD ?? 'porta-developer';
  return [
    { account_id: deriveStableAccountId('admin'), user_id: 'admin', password: adminPassword, role: 'admin', display_name: 'Admin', auth_provider: 'local', source: 'default' },
    { account_id: deriveStableAccountId('operator'), user_id: 'operator', password: operatorPassword, role: 'operator', display_name: 'Operator', auth_provider: 'local', source: 'default' },
    { account_id: deriveStableAccountId('auditor'), user_id: 'auditor', password: auditorPassword, role: 'auditor', display_name: 'Auditor', auth_provider: 'local', source: 'default' },
    { account_id: deriveStableAccountId('developer'), user_id: 'developer', password: developerPassword, role: 'developer', display_name: 'Developer', auth_provider: 'local', source: 'default' }
  ];
}

function parseUserRows(raw: unknown, source: UserSource): LocalAuthUserRecord[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const users: LocalAuthUserRecord[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const accountId = typeof row.account_id === 'string' && row.account_id.trim().length > 0
      ? row.account_id.trim()
      : '';
    const userId = typeof row.user_id === 'string' ? row.user_id.trim() : '';
    const password = typeof row.password === 'string' ? row.password : '';
    const role = typeof row.role === 'string' ? row.role as AuthRole : 'viewer';
    const displayName = typeof row.display_name === 'string' ? row.display_name : userId;
    const avatarUrl = typeof row.avatar_url === 'string' ? row.avatar_url.trim() : '';
    const authProvider = typeof row.auth_provider === 'string'
      && (row.auth_provider === 'local' || row.auth_provider === 'google' || row.auth_provider === 'microsoft' || row.auth_provider === 'sso')
      ? row.auth_provider
      : 'local';
    if (!userId || !password) continue;
    if (role !== 'viewer' && role !== 'operator' && role !== 'admin' && role !== 'auditor' && role !== 'developer' && role !== 'agent') continue;
    users.push({
      account_id: accountId || deriveStableAccountId(userId),
      user_id: userId,
      password,
      role,
      display_name: displayName,
      ...(avatarUrl.length > 0 ? { avatar_url: avatarUrl } : {}),
      ...(authProvider ? { auth_provider: authProvider } : {}),
      source
    });
  }
  return users;
}

function loadBaseUsers(): LocalAuthUserRecord[] {
  const envRaw = process.env.AUTH_USERS_JSON;
  if (!envRaw || envRaw.trim().length === 0) {
    return stableUsers();
  }

  try {
    const parsed = JSON.parse(envRaw);
    const users = parseUserRows(parsed, 'env');
    return users.length > 0 ? users : stableUsers();
  } catch {
    return stableUsers();
  }
}

function loadCustomUsersFromFiles(): LocalAuthUserRecord[] {
  const table = new Map<string, LocalAuthUserRecord>();
  const candidatePaths = new Set([usersPath, homeUsersPath, moduleUsersPath, legacyUsersPath]);
  for (const candidate of candidatePaths) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const customUsers = parseUserRows(parsed, 'custom');
      for (const user of customUsers) {
        table.set(user.user_id.toLowerCase(), user);
      }
    } catch {
      // ignore malformed user store in R&D mode
    }
  }
  return [...table.values()];
}

function persistMemoryCustomUsers(): void {
  const custom = memoryCustomUsers.map((user) => ({
    account_id: user.account_id,
    user_id: user.user_id,
    password: user.password,
    role: user.role,
    display_name: user.display_name,
    ...(user.avatar_url ? { avatar_url: user.avatar_url } : {}),
    ...(user.auth_provider ? { auth_provider: user.auth_provider } : {})
  }));
  fs.mkdirSync(path.dirname(usersPath), { recursive: true });
  const tmpPath = `${usersPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(custom, null, 2));
  fs.renameSync(tmpPath, usersPath);

  const mirrors = new Set([legacyUsersPath, moduleUsersPath]);
  for (const mirrorPath of mirrors) {
    if (mirrorPath === usersPath) continue;
    try {
      fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
      const mirrorTmp = `${mirrorPath}.tmp`;
      fs.writeFileSync(mirrorTmp, JSON.stringify(custom, null, 2));
      fs.renameSync(mirrorTmp, mirrorPath);
    } catch {
      // best-effort mirror for compatibility with older runtime paths.
    }
  }
}

function safeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function resolveRole(userId: string, role: AuthRole): AuthRole {
  return resolveAssignedRoleForUser(userId, role);
}

function toAuthenticatedViewFromLocal(user: LocalAuthUserRecord): AuthenticatedAuthUserView {
  return {
    account_id: user.account_id,
    user_id: user.user_id,
    base_role: user.role,
    role: resolveRole(user.user_id, user.role),
    display_name: user.display_name,
    ...(user.avatar_url ? { avatar_url: user.avatar_url } : {}),
    ...(user.auth_provider ? { auth_provider: user.auth_provider } : {}),
    source: user.source
  };
}

function toAuthenticatedViewFromStored(user: StoredAuthUserRecord): AuthenticatedAuthUserView {
  return {
    account_id: user.account_id,
    user_id: user.user_id,
    base_role: user.role,
    role: resolveRole(user.user_id, user.role),
    display_name: user.display_name,
    ...(user.avatar_url ? { avatar_url: user.avatar_url } : {}),
    ...(user.auth_provider ? { auth_provider: user.auth_provider } : {}),
    source: user.source
  };
}

function toIdentityView(user: AuthenticatedAuthUserView): AuthUserIdentityView {
  return {
    account_id: user.account_id,
    user_id: user.user_id,
    role: user.role,
    display_name: user.display_name,
    ...(user.avatar_url ? { avatar_url: user.avatar_url } : {}),
    ...(user.auth_provider ? { auth_provider: user.auth_provider } : {}),
    source: user.source
  };
}

function cleanupExpiredSessions(): void {
  const nowMs = Date.now();
  for (const [token, session] of sessions.entries()) {
    const expiryMs = Date.parse(session.expires_at_utc);
    if (!Number.isFinite(expiryMs) || expiryMs <= nowMs) {
      sessions.delete(token);
    }
  }
}

function toSessionView(record: SessionRecord): AuthSessionView {
  return {
    account_id: record.account_id,
    user_id: record.user_id,
    role: record.role,
    display_name: record.display_name,
    ...(record.avatar_url ? { avatar_url: record.avatar_url } : {}),
    ...(record.auth_provider ? { auth_provider: record.auth_provider } : {}),
    issued_at_utc: record.issued_at_utc,
    expires_at_utc: record.expires_at_utc,
    reauth_expires_at_utc: record.reauth_expires_at_utc
  };
}

function toSessionViewFromStored(record: StoredAuthSessionRecord): AuthSessionView {
  return {
    account_id: record.account_id,
    user_id: record.user_id,
    role: record.role,
    display_name: record.display_name,
    ...(record.avatar_url ? { avatar_url: record.avatar_url } : {}),
    ...(record.auth_provider ? { auth_provider: record.auth_provider } : {}),
    issued_at_utc: record.issued_at_utc,
    expires_at_utc: record.expires_at_utc,
    reauth_expires_at_utc: record.reauth_expires_at_utc
  };
}

function findMemoryCustomUser(userId: string): LocalAuthUserRecord | undefined {
  const normalized = userId.trim().toLowerCase();
  return memoryCustomUsers.find((row) => row.user_id.toLowerCase() === normalized);
}

function findBaseUser(userId: string): LocalAuthUserRecord | undefined {
  const normalized = userId.trim().toLowerCase();
  return baseUsers.find((row) => row.user_id.toLowerCase() === normalized);
}

function findLocalUser(userId: string): LocalAuthUserRecord | undefined {
  return (allowLegacyCustomUserFallback() ? findMemoryCustomUser(userId) : undefined)
    ?? findBaseUser(userId);
}

function upsertMemoryCustomUser(record: LocalAuthUserRecord): void {
  const table = new Map(memoryCustomUsers.map((entry) => [entry.user_id.toLowerCase(), entry]));
  table.set(record.user_id.toLowerCase(), record);
  memoryCustomUsers = [...table.values()];
}

function buildLegacyCustomUserRecord(input: {
  account_id: string;
  user_id: string;
  password: string;
  role: AuthRole;
  display_name: string;
  avatar_url?: string | null;
  auth_provider?: AuthProvider | null;
}): LocalAuthUserRecord {
  return {
    account_id: input.account_id,
    user_id: input.user_id,
    password: input.password,
    role: input.role,
    display_name: input.display_name,
    ...(input.avatar_url ? { avatar_url: input.avatar_url } : {}),
    ...(input.auth_provider ? { auth_provider: input.auth_provider } : {}),
    source: 'custom'
  };
}

function mirrorLegacyCustomUser(record: LocalAuthUserRecord): void {
  if (!shouldMirrorLegacyCustomUsers()) {
    return;
  }

  upsertMemoryCustomUser(record);
  persistMemoryCustomUsers();
}

async function ensureLegacyCustomUsersImported(): Promise<void> {
  if (getFleetPersistenceMode() !== 'postgres') {
    return;
  }

  if (!legacyImportPromise) {
    legacyImportPromise = (async () => {
      const legacyUsers = loadCustomUsersFromFiles();
      if (legacyUsers.length === 0) {
        return;
      }

      const importRows: LegacyAuthUserImportRow[] = legacyUsers.map((user) => ({
        account_id: user.account_id,
        user_id: user.user_id,
        password: user.password,
        role: user.role,
        display_name: user.display_name,
        ...(user.avatar_url ? { avatar_url: user.avatar_url } : {}),
        ...(user.auth_provider ? { auth_provider: user.auth_provider } : {}),
        source: user.source
      }));
      await importLegacyAuthUsers(importRows);
    })().catch((error) => {
      legacyImportPromise = null;
      throw error;
    });
  }

  await legacyImportPromise;
}

async function findResolvedUser(userId: string): Promise<AuthenticatedAuthUserView | null> {
  const normalized = userId.trim();
  if (!normalized) {
    return null;
  }

  if (getFleetPersistenceMode() === 'postgres') {
    await ensureLegacyCustomUsersImported();
    const custom = await findAuthUserRecordByUserId(normalized);
    if (custom) {
      return toAuthenticatedViewFromStored(custom);
    }
  }

  const local = findLocalUser(normalized);
  return local ? toAuthenticatedViewFromLocal(local) : null;
}

function listLocalUsers(): AuthenticatedAuthUserView[] {
  const table = new Map<string, AuthenticatedAuthUserView>();
  for (const user of baseUsers) {
    table.set(user.user_id.toLowerCase(), toAuthenticatedViewFromLocal(user));
  }
  if (allowLegacyCustomUserFallback()) {
    for (const user of memoryCustomUsers) {
      table.set(user.user_id.toLowerCase(), toAuthenticatedViewFromLocal(user));
    }
  }
  return [...table.values()];
}

function syncSessionSnapshots(user: AuthenticatedAuthUserView): void {
  for (const record of sessions.values()) {
    if (record.user_id.toLowerCase() !== user.user_id.toLowerCase()) {
      continue;
    }

    record.base_role = user.base_role;
    record.role = user.role;
    record.display_name = user.display_name;
    record.source = user.source;
    if (user.avatar_url) {
      record.avatar_url = user.avatar_url;
    } else {
      delete record.avatar_url;
    }
    if (user.auth_provider) {
      record.auth_provider = user.auth_provider;
    } else {
      delete record.auth_provider;
    }
  }
}

function validateAvatarUrl(value: string): boolean {
  if (!value) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateStrongPassword(password: string, prefix: string): string | null {
  if (password.length < PASSWORD_MIN) {
    return `${prefix} must be at least ${PASSWORD_MIN} characters.`;
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    return `${prefix} must include uppercase, lowercase, and number.`;
  }
  return null;
}

export async function hasAuthUser(userId: string): Promise<boolean> {
  return Boolean(await findResolvedUser(userId));
}

export async function authenticateUser(userId: string, password: string): Promise<AuthenticatedAuthUserView | null> {
  const normalized = userId.trim();
  if (!normalized || !password) {
    return null;
  }

  if (getFleetPersistenceMode() === 'postgres') {
    await ensureLegacyCustomUsersImported();
    const existingCustom = await findAuthUserRecordByUserId(normalized);
    if (existingCustom) {
      const custom = await verifyAuthUserPassword(normalized, password);
      return custom ? toAuthenticatedViewFromStored(custom) : null;
    }
  }

  const local = findLocalUser(normalized);
  if (!local || !safeEquals(local.password, password)) {
    return null;
  }
  return toAuthenticatedViewFromLocal(local);
}

export async function issueAuthSession(
  user: AuthenticatedAuthUserView,
  overrides: { account_id?: string } = {}
): Promise<{ access_token: string; session: AuthSessionView }> {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + sessionTtlMinutes() * 60_000);
  const reauthExpiresAt = new Date(issuedAt.getTime() + reauthTtlMinutes() * 60_000);
  const token = randomBytes(32).toString('base64url');

  if (getFleetPersistenceMode() === 'postgres') {
    const stored = await createAuthSessionRecord({
      token,
      account_id: overrides.account_id ?? user.account_id,
      user_id: user.user_id,
      role: user.role,
      display_name: user.display_name,
      ...(user.avatar_url ? { avatar_url: user.avatar_url } : {}),
      ...(user.auth_provider ? { auth_provider: user.auth_provider } : {}),
      issued_at_utc: issuedAt.toISOString(),
      expires_at_utc: expiresAt.toISOString(),
      reauth_expires_at_utc: reauthExpiresAt.toISOString()
    });
    if (!stored) {
      throw new Error('Auth session could not be persisted.');
    }
    return {
      access_token: token,
      session: toSessionViewFromStored(stored)
    };
  }

  cleanupExpiredSessions();
  const record: SessionRecord = {
    token,
    account_id: overrides.account_id ?? user.account_id,
    user_id: user.user_id,
    base_role: user.base_role,
    role: user.role,
    display_name: user.display_name,
    ...(user.avatar_url ? { avatar_url: user.avatar_url } : {}),
    ...(user.auth_provider ? { auth_provider: user.auth_provider } : {}),
    source: user.source,
    issued_at_utc: issuedAt.toISOString(),
    expires_at_utc: expiresAt.toISOString(),
    reauth_expires_at_utc: reauthExpiresAt.toISOString()
  };
  sessions.set(token, record);
  return {
    access_token: token,
    session: toSessionView(record)
  };
}

export async function readAuthSession(token: string): Promise<AuthSessionView | null> {
  if (getFleetPersistenceMode() === 'postgres') {
    const record = await findAuthSessionRecordByToken(token);
    if (!record || record.revoked_at_utc) {
      return null;
    }

    const expiryMs = Date.parse(record.expires_at_utc);
    if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) {
      return null;
    }

    const identity = await readAuthUserIdentity(record.user_id);
    if (!identity) {
      return toSessionViewFromStored(record);
    }

    const changed = record.account_id !== identity.account_id
      || record.role !== identity.role
      || record.display_name !== identity.display_name
      || record.avatar_url !== (identity.avatar_url ?? null)
      || record.auth_provider !== (identity.auth_provider ?? null);

    if (!changed) {
      return toSessionViewFromStored(record);
    }

    const updated = await updateAuthSessionRecord({
      session_id: record.session_id,
      account_id: identity.account_id,
      role: identity.role,
      display_name: identity.display_name,
      avatar_url: identity.avatar_url ?? null,
      auth_provider: identity.auth_provider ?? null,
      updated_at_utc: new Date().toISOString()
    });

    return updated ? toSessionViewFromStored(updated) : toSessionViewFromStored(record);
  }

  cleanupExpiredSessions();
  const record = sessions.get(token);
  if (!record) return null;

  const canRefreshFromLocal = record.source !== 'custom' || getFleetPersistenceMode() === 'memory';
  if (canRefreshFromLocal) {
    const local = findLocalUser(record.user_id);
    if (local) {
      const refreshed = toAuthenticatedViewFromLocal(local);
      const changed = record.base_role !== refreshed.base_role
        || record.role !== refreshed.role
        || record.display_name !== refreshed.display_name
        || record.avatar_url !== refreshed.avatar_url
        || record.auth_provider !== refreshed.auth_provider
        || record.source !== refreshed.source;
      if (changed) {
        record.base_role = refreshed.base_role;
        record.role = refreshed.role;
        record.display_name = refreshed.display_name;
        record.source = refreshed.source;
        if (refreshed.avatar_url) {
          record.avatar_url = refreshed.avatar_url;
        } else {
          delete record.avatar_url;
        }
        if (refreshed.auth_provider) {
          record.auth_provider = refreshed.auth_provider;
        } else {
          delete record.auth_provider;
        }
        sessions.set(token, record);
      }
    }
  } else {
    const assignedRole = resolveRole(record.user_id, record.base_role);
    if (assignedRole !== record.role) {
      record.role = assignedRole;
      sessions.set(token, record);
    }
  }

  return toSessionView(record);
}

export async function revokeAuthSession(token: string): Promise<void> {
  if (getFleetPersistenceMode() === 'postgres') {
    await revokeAuthSessionRecord(token, new Date().toISOString());
    return;
  }

  sessions.delete(token);
}

export async function refreshReauth(token: string): Promise<AuthSessionView | null> {
  if (getFleetPersistenceMode() === 'postgres') {
    const record = await findAuthSessionRecordByToken(token);
    if (!record || record.revoked_at_utc) {
      return null;
    }

    const expiryMs = Date.parse(record.expires_at_utc);
    if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) {
      return null;
    }

    const reauthExpiresAt = new Date(Date.now() + reauthTtlMinutes() * 60_000).toISOString();
    const updated = await updateAuthSessionRecord({
      session_id: record.session_id,
      reauth_expires_at_utc: reauthExpiresAt,
      updated_at_utc: reauthExpiresAt
    });
    return updated ? toSessionViewFromStored(updated) : null;
  }

  cleanupExpiredSessions();
  const record = sessions.get(token);
  if (!record) return null;
  const reauthExpiresAt = new Date(Date.now() + reauthTtlMinutes() * 60_000).toISOString();
  record.reauth_expires_at_utc = reauthExpiresAt;
  sessions.set(token, record);
  return toSessionView(record);
}

export function hasValidReauth(session: AuthSessionView): boolean {
  const expiresMs = Date.parse(session.reauth_expires_at_utc);
  return Number.isFinite(expiresMs) && expiresMs > Date.now();
}

export async function listAuthUsers(): Promise<Array<Pick<AuthUserPublicView, 'user_id' | 'role' | 'display_name'>>> {
  const table = new Map<string, AuthenticatedAuthUserView>();
  for (const user of listLocalUsers()) {
    table.set(user.user_id.toLowerCase(), user);
  }

  if (getFleetPersistenceMode() === 'postgres') {
    await ensureLegacyCustomUsersImported();
    const storedUsers = await listAuthUserRecords();
    for (const user of storedUsers) {
      table.set(user.user_id.toLowerCase(), toAuthenticatedViewFromStored(user));
    }
  }

  return [...table.values()]
    .sort((a, b) => a.user_id.localeCompare(b.user_id))
    .map((row) => ({
      user_id: row.user_id,
      role: row.role,
      display_name: row.display_name
    }));
}

export async function readAuthUserIdentity(userId: string): Promise<AuthUserIdentityView | null> {
  const user = await findResolvedUser(userId);
  return user ? toIdentityView(user) : null;
}

export async function resolveAuthUserRole(userId: string): Promise<AuthRole | null> {
  const user = await findResolvedUser(userId);
  return user?.role ?? null;
}

export function readAuthAccessHelp(): AuthAccessHelpView {
  return {
    signup_enabled: allowSelfRegister(),
    admin_signup_enabled: allowSelfRegisterAdmin(),
    signup_code_required: requireSignupCode(),
    signup_code_length: 6,
    user_id_rules: {
      pattern: USER_ID_PATTERN_STRING,
      min_length: USER_ID_MIN,
      max_length: USER_ID_MAX,
      example: 'name@company.com'
    },
    password_rules: {
      min_length: PASSWORD_MIN,
      requires_upper: true,
      requires_lower: true,
      requires_number: true
    }
  };
}

export async function registerAuthUser(input: {
  user_id: string;
  password: string;
  role: AuthRole;
  display_name: string;
  avatar_url?: string;
  signup_code?: string;
}):
  Promise<
    | { ok: true; user: AuthUserPublicView }
    | { ok: false; error_code: string; message: string }
  >
{
  if (!allowSelfRegister()) {
    return { ok: false, error_code: 'SIGNUP_DISABLED', message: 'Self registration is disabled.' };
  }

  const userId = input.user_id.trim();
  const password = input.password;
  const signupCode = (input.signup_code ?? '').trim();
  const displayName = input.display_name.trim();
  const avatarUrl = typeof input.avatar_url === 'string' ? input.avatar_url.trim() : '';
  const role = input.role;

  if (!userId || !displayName) {
    return {
      ok: false,
      error_code: 'VALIDATION_ERROR',
      message: 'user_id and display_name are required.'
    };
  }
  if (requireSignupCode() && !/^\d{6}$/.test(signupCode)) {
    return {
      ok: false,
      error_code: 'INVALID_SIGNUP_CODE',
      message: 'signup_code must be a 6-digit code issued by admin.'
    };
  }
  if (!USER_ID_PATTERN.test(userId)) {
    return {
      ok: false,
      error_code: 'INVALID_USER_ID',
      message: 'user_id must be a valid email address.'
    };
  }
  if (password.length < PASSWORD_MIN) {
    return {
      ok: false,
      error_code: 'WEAK_PASSWORD',
      message: `password must be at least ${PASSWORD_MIN} characters and include upper/lower/number.`
    };
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    return {
      ok: false,
      error_code: 'WEAK_PASSWORD',
      message: 'password must include at least one uppercase letter, one lowercase letter, and one number.'
    };
  }

  if (role === 'agent') {
    return { ok: false, error_code: 'VALIDATION_ERROR', message: 'agent role cannot be self-registered.' };
  }

  if (role === 'admin' && !allowSelfRegisterAdmin()) {
    return {
      ok: false,
      error_code: 'ADMIN_SIGNUP_DISABLED',
      message: 'Admin self registration is disabled.'
    };
  }

  if (await findResolvedUser(userId)) {
    return {
      ok: false,
      error_code: 'USER_EXISTS',
      message: 'User already exists.'
    };
  }

  if (requireSignupCode()) {
    const consumed = consumeSignupCode(signupCode);
    if (!consumed.ok) {
      return consumed;
    }
  }

  if (getFleetPersistenceMode() === 'postgres') {
    const created = await createAuthUserRecord({
      account_id: randomUUID(),
      user_id: userId,
      password,
      role,
      display_name: displayName,
      ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
      auth_provider: 'local',
      source: 'custom'
    });
    if (!created) {
      return { ok: false, error_code: 'USER_CREATE_FAILED', message: 'User could not be created.' };
    }

    mirrorLegacyCustomUser(buildLegacyCustomUserRecord({
      account_id: created.account_id,
      user_id: created.user_id,
      password,
      role,
      display_name: displayName,
      ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
      auth_provider: 'local'
    }));

    const publicView = toAuthenticatedViewFromStored(created);
    return {
      ok: true,
      user: {
        account_id: publicView.account_id,
        user_id: publicView.user_id,
        role: publicView.role,
        display_name: publicView.display_name,
        ...(publicView.avatar_url ? { avatar_url: publicView.avatar_url } : {}),
        ...(publicView.auth_provider ? { auth_provider: publicView.auth_provider } : {})
      }
    };
  }

  const record: LocalAuthUserRecord = {
    account_id: randomUUID(),
    user_id: userId,
    password,
    role,
    display_name: displayName,
    ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
    auth_provider: 'local',
    source: 'custom'
  };
  memoryCustomUsers = [...memoryCustomUsers, record];
  persistMemoryCustomUsers();

  const publicView = toAuthenticatedViewFromLocal(record);
  return {
    ok: true,
    user: {
      account_id: publicView.account_id,
      user_id: publicView.user_id,
      role: publicView.role,
      display_name: publicView.display_name,
      ...(publicView.avatar_url ? { avatar_url: publicView.avatar_url } : {}),
      ...(publicView.auth_provider ? { auth_provider: publicView.auth_provider } : {})
    }
  };
}

export async function updateAuthUserProfile(input: {
  user_id: string;
  display_name?: string;
  avatar_url?: string | null;
}): Promise<{ ok: true; user: AuthUserPublicView } | { ok: false; error_code: string; message: string }> {
  const normalizedUserId = input.user_id.trim();
  if (!normalizedUserId) {
    return { ok: false, error_code: 'USER_NOT_FOUND', message: 'User not found.' };
  }

  if (getFleetPersistenceMode() === 'postgres') {
    await ensureLegacyCustomUsersImported();
    const existing = await findAuthUserRecordByUserId(normalizedUserId);
    if (existing) {
      const nextDisplay = typeof input.display_name === 'string' ? input.display_name.trim() : existing.display_name;
      if (!nextDisplay) {
        return { ok: false, error_code: 'VALIDATION_ERROR', message: 'display_name is required.' };
      }

      let nextAvatar: string | null | undefined = existing.avatar_url;
      if (input.avatar_url === null) {
        nextAvatar = null;
      } else if (typeof input.avatar_url === 'string') {
        const trimmed = input.avatar_url.trim();
        if (!validateAvatarUrl(trimmed)) {
          return { ok: false, error_code: 'VALIDATION_ERROR', message: 'avatar_url must be http/https URL.' };
        }
        nextAvatar = trimmed.length > 0 ? trimmed : null;
      }

      const updated = await updateAuthUserRecord({
        user_id: normalizedUserId,
        display_name: nextDisplay,
        ...(nextAvatar !== undefined ? { avatar_url: nextAvatar } : {}),
        updated_at: new Date().toISOString()
      });
      if (!updated) {
        return { ok: false, error_code: 'USER_NOT_FOUND', message: 'User not found.' };
      }

      const publicView = toAuthenticatedViewFromStored(updated);
      if (shouldMirrorLegacyCustomUsers()) {
        const mirrored = findMemoryCustomUser(normalizedUserId);
        if (mirrored) {
          mirrorLegacyCustomUser(buildLegacyCustomUserRecord({
            account_id: updated.account_id,
            user_id: updated.user_id,
            password: mirrored.password,
            role: updated.role,
            display_name: updated.display_name,
            avatar_url: updated.avatar_url ?? null,
            auth_provider: updated.auth_provider ?? null
          }));
        }
      }
      syncSessionSnapshots(publicView);
      return {
        ok: true,
        user: {
          account_id: publicView.account_id,
          user_id: publicView.user_id,
          role: publicView.role,
          display_name: publicView.display_name,
          ...(publicView.avatar_url ? { avatar_url: publicView.avatar_url } : {}),
          ...(publicView.auth_provider ? { auth_provider: publicView.auth_provider } : {})
        }
      };
    }
  }

  const user = findLocalUser(normalizedUserId);
  if (!user) {
    return { ok: false, error_code: 'USER_NOT_FOUND', message: 'User not found.' };
  }

  const nextDisplay = typeof input.display_name === 'string' ? input.display_name.trim() : user.display_name;
  if (!nextDisplay) {
    return { ok: false, error_code: 'VALIDATION_ERROR', message: 'display_name is required.' };
  }

  let nextAvatar = user.avatar_url;
  if (input.avatar_url === null) {
    nextAvatar = undefined;
  } else if (typeof input.avatar_url === 'string') {
    const trimmed = input.avatar_url.trim();
    if (!validateAvatarUrl(trimmed)) {
      return { ok: false, error_code: 'VALIDATION_ERROR', message: 'avatar_url must be http/https URL.' };
    }
    nextAvatar = trimmed.length > 0 ? trimmed : undefined;
  }

  user.display_name = nextDisplay;
  if (nextAvatar) {
    user.avatar_url = nextAvatar;
  } else {
    delete user.avatar_url;
  }

  if (user.source === 'custom') {
    memoryCustomUsers = [...memoryCustomUsers];
    persistMemoryCustomUsers();
  } else {
    baseUsers = [...baseUsers];
  }

  const publicView = toAuthenticatedViewFromLocal(user);
  syncSessionSnapshots(publicView);
  return {
    ok: true,
    user: {
      account_id: publicView.account_id,
      user_id: publicView.user_id,
      role: publicView.role,
      display_name: publicView.display_name,
      ...(publicView.avatar_url ? { avatar_url: publicView.avatar_url } : {}),
      ...(publicView.auth_provider ? { auth_provider: publicView.auth_provider } : {})
    }
  };
}

export async function updateAuthUserPassword(input: {
  user_id: string;
  current_password: string;
  new_password: string;
}): Promise<{ ok: true } | { ok: false; error_code: string; message: string }> {
  const normalizedUserId = input.user_id.trim();
  if (!normalizedUserId) {
    return { ok: false, error_code: 'USER_NOT_FOUND', message: 'User not found.' };
  }

  if (getFleetPersistenceMode() === 'postgres') {
    await ensureLegacyCustomUsersImported();
    const existing = await findAuthUserRecordByUserId(normalizedUserId);
    if (existing) {
      const verified = await verifyAuthUserPassword(normalizedUserId, input.current_password);
      if (!verified) {
        return { ok: false, error_code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' };
      }

      const passwordMessage = validateStrongPassword(input.new_password, 'New password');
      if (passwordMessage) {
        return { ok: false, error_code: 'WEAK_PASSWORD', message: passwordMessage };
      }

      const updated = await updateAuthUserPasswordRecord(normalizedUserId, input.new_password);
      if (updated && shouldMirrorLegacyCustomUsers()) {
        mirrorLegacyCustomUser(buildLegacyCustomUserRecord({
          account_id: existing.account_id,
          user_id: existing.user_id,
          password: input.new_password,
          role: existing.role,
          display_name: existing.display_name,
          avatar_url: existing.avatar_url ?? null,
          auth_provider: existing.auth_provider ?? null
        }));
      }
      return updated
        ? { ok: true }
        : { ok: false, error_code: 'USER_NOT_FOUND', message: 'User not found.' };
    }
  }

  const user = findLocalUser(normalizedUserId);
  if (!user) {
    return { ok: false, error_code: 'USER_NOT_FOUND', message: 'User not found.' };
  }
  if (!safeEquals(user.password, input.current_password)) {
    return { ok: false, error_code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' };
  }

  const passwordMessage = validateStrongPassword(input.new_password, 'New password');
  if (passwordMessage) {
    return { ok: false, error_code: 'WEAK_PASSWORD', message: passwordMessage };
  }

  user.password = input.new_password;
  if (user.source === 'custom') {
    memoryCustomUsers = [...memoryCustomUsers];
    persistMemoryCustomUsers();
  } else {
    baseUsers = [...baseUsers];
  }
  return { ok: true };
}

export async function resetAuthUserPasswordWithCode(input: {
  user_id: string;
  reset_code: string;
  new_password: string;
}): Promise<{ ok: true } | { ok: false; error_code: string; message: string }> {
  const userId = input.user_id.trim();
  const resetCode = input.reset_code.trim();
  const newPassword = input.new_password;
  if (!userId) {
    return { ok: false, error_code: 'USER_NOT_FOUND', message: 'User not found.' };
  }
  if (!/^\d{6}$/.test(resetCode)) {
    return { ok: false, error_code: 'INVALID_RESET_CODE', message: 'reset_code must be a 6-digit code.' };
  }

  let existingCustom: StoredAuthUserRecord | null = null;
  if (getFleetPersistenceMode() === 'postgres') {
    await ensureLegacyCustomUsersImported();
    existingCustom = await findAuthUserRecordByUserId(userId);
    if (!existingCustom && !findLocalUser(userId)) {
      return { ok: false, error_code: 'USER_NOT_FOUND', message: 'User not found.' };
    }
  } else if (!findLocalUser(userId)) {
    return { ok: false, error_code: 'USER_NOT_FOUND', message: 'User not found.' };
  }

  const passwordMessage = validateStrongPassword(newPassword, 'New password');
  if (passwordMessage) {
    return { ok: false, error_code: 'WEAK_PASSWORD', message: passwordMessage };
  }

  const consumed = consumePasswordResetCode({ code: resetCode, userId });
  if (!consumed.ok) return consumed;

  if (existingCustom) {
    const updated = await updateAuthUserPasswordRecord(userId, newPassword);
    if (updated && shouldMirrorLegacyCustomUsers()) {
      mirrorLegacyCustomUser(buildLegacyCustomUserRecord({
        account_id: existingCustom.account_id,
        user_id: existingCustom.user_id,
        password: newPassword,
        role: existingCustom.role,
        display_name: existingCustom.display_name,
        avatar_url: existingCustom.avatar_url ?? null,
        auth_provider: existingCustom.auth_provider ?? null
      }));
    }
    return updated
      ? { ok: true }
      : { ok: false, error_code: 'USER_NOT_FOUND', message: 'User not found.' };
  }

  const user = findLocalUser(userId);
  if (!user) {
    return { ok: false, error_code: 'USER_NOT_FOUND', message: 'User not found.' };
  }

  user.password = newPassword;
  if (user.source === 'custom') {
    memoryCustomUsers = [...memoryCustomUsers];
    persistMemoryCustomUsers();
  } else {
    baseUsers = [...baseUsers];
  }
  return { ok: true };
}

export function clearAuthSessionStoreForTests(): void {
  sessions.clear();
}
