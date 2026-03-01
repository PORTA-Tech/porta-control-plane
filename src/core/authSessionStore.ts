import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolveAssignedRoleForUser } from './rbacStore.js';

type AuthRole = 'viewer' | 'operator' | 'admin' | 'auditor' | 'developer' | 'agent';
type UserSource = 'default' | 'env' | 'custom';

interface AuthUserRecord {
  user_id: string;
  password: string;
  role: AuthRole;
  display_name: string;
  source: UserSource;
}

interface SessionRecord {
  token: string;
  user_id: string;
  role: AuthRole;
  display_name: string;
  issued_at_utc: string;
  expires_at_utc: string;
  reauth_expires_at_utc: string;
}

export interface AuthSessionView {
  user_id: string;
  role: AuthRole;
  display_name: string;
  issued_at_utc: string;
  expires_at_utc: string;
  reauth_expires_at_utc: string;
}

export interface AuthAccessHelpView {
  signup_enabled: boolean;
  admin_signup_enabled: boolean;
  users: Array<{ user_id: string; role: AuthRole; display_name: string }>;
  default_credentials: Array<{ user_id: string; role: AuthRole; password: string }>;
}

const sessions = new Map<string, SessionRecord>();
const usersPath = path.resolve('.data', 'auth-users.json');

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
  return parsePositiveInt(process.env.AUTH_SESSION_TTL_MINUTES, 8 * 60);
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

function exposeBootstrapCredentials(): boolean {
  return parseBoolean(process.env.AUTH_EXPOSE_BOOTSTRAP_CREDENTIALS, true);
}

function stableUsers(): AuthUserRecord[] {
  const adminPassword = process.env.AUTH_DEFAULT_ADMIN_PASSWORD ?? 'porta-admin';
  const operatorPassword = process.env.AUTH_DEFAULT_OPERATOR_PASSWORD ?? 'porta-operator';
  const auditorPassword = process.env.AUTH_DEFAULT_AUDITOR_PASSWORD ?? 'porta-auditor';
  const developerPassword = process.env.AUTH_DEFAULT_DEVELOPER_PASSWORD ?? 'porta-developer';
  return [
    { user_id: 'admin', password: adminPassword, role: 'admin', display_name: 'Admin', source: 'default' },
    { user_id: 'operator', password: operatorPassword, role: 'operator', display_name: 'Operator', source: 'default' },
    { user_id: 'auditor', password: auditorPassword, role: 'auditor', display_name: 'Auditor', source: 'default' },
    { user_id: 'developer', password: developerPassword, role: 'developer', display_name: 'Developer', source: 'default' }
  ];
}

function parseUserRows(raw: unknown, source: UserSource): AuthUserRecord[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const users: AuthUserRecord[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const userId = typeof row.user_id === 'string' ? row.user_id.trim() : '';
    const password = typeof row.password === 'string' ? row.password : '';
    const role = typeof row.role === 'string' ? row.role as AuthRole : 'viewer';
    const displayName = typeof row.display_name === 'string' ? row.display_name : userId;
    if (!userId || !password) continue;
    if (role !== 'viewer' && role !== 'operator' && role !== 'admin' && role !== 'auditor' && role !== 'developer' && role !== 'agent') continue;
    users.push({ user_id: userId, password, role, display_name: displayName, source });
  }
  return users;
}

function loadUsers(): AuthUserRecord[] {
  const table = new Map<string, AuthUserRecord>();

  const envRaw = process.env.AUTH_USERS_JSON;
  const baseUsers = (() => {
    if (!envRaw || envRaw.trim().length === 0) return stableUsers();
    try {
      const parsed = JSON.parse(envRaw);
      const users = parseUserRows(parsed, 'env');
      return users.length > 0 ? users : stableUsers();
    } catch {
      return stableUsers();
    }
  })();

  for (const user of baseUsers) {
    table.set(user.user_id.toLowerCase(), user);
  }

  if (fs.existsSync(usersPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
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

let authUsers: AuthUserRecord[] = loadUsers();

function persistCustomUsers(): void {
  const custom = authUsers.filter((user) => user.source === 'custom').map((user) => ({
    user_id: user.user_id,
    password: user.password,
    role: user.role,
    display_name: user.display_name
  }));
  fs.mkdirSync(path.dirname(usersPath), { recursive: true });
  const tmpPath = `${usersPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(custom, null, 2));
  fs.renameSync(tmpPath, usersPath);
}

function safeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
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
    user_id: record.user_id,
    role: record.role,
    display_name: record.display_name,
    issued_at_utc: record.issued_at_utc,
    expires_at_utc: record.expires_at_utc,
    reauth_expires_at_utc: record.reauth_expires_at_utc
  };
}

function findUser(userId: string): AuthUserRecord | undefined {
  const normalized = userId.trim().toLowerCase();
  return authUsers.find((row) => row.user_id.toLowerCase() === normalized);
}

export function authenticateUser(userId: string, password: string): AuthUserRecord | null {
  const user = findUser(userId);
  if (!user) return null;
  if (!safeEquals(user.password, password)) return null;
  return {
    ...user,
    role: resolveAssignedRoleForUser(user.user_id, user.role)
  };
}

export function issueAuthSession(user: Pick<AuthUserRecord, 'user_id' | 'role' | 'display_name'>): { access_token: string; session: AuthSessionView } {
  cleanupExpiredSessions();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + sessionTtlMinutes() * 60_000);
  const reauthExpiresAt = new Date(issuedAt.getTime() + reauthTtlMinutes() * 60_000);
  const token = randomBytes(32).toString('base64url');
  const record: SessionRecord = {
    token,
    user_id: user.user_id,
    role: user.role,
    display_name: user.display_name,
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

export function readAuthSession(token: string): AuthSessionView | null {
  cleanupExpiredSessions();
  const record = sessions.get(token);
  if (!record) return null;
  const user = findUser(record.user_id);
  if (user) {
    const assignedRole = resolveAssignedRoleForUser(record.user_id, user.role);
    if (assignedRole !== record.role) {
      record.role = assignedRole;
      sessions.set(token, record);
    }
  }
  return toSessionView(record);
}

export function revokeAuthSession(token: string): void {
  sessions.delete(token);
}

export function refreshReauth(token: string): AuthSessionView | null {
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

export function listAuthUsers(): Array<Pick<AuthUserRecord, 'user_id' | 'role' | 'display_name'>> {
  return [...authUsers]
    .sort((a, b) => a.user_id.localeCompare(b.user_id))
    .map((row) => ({
      user_id: row.user_id,
      role: resolveAssignedRoleForUser(row.user_id, row.role),
      display_name: row.display_name
    }));
}

export function resolveAuthUserRole(userId: string): AuthRole | null {
  const user = findUser(userId);
  if (!user) return null;
  return resolveAssignedRoleForUser(user.user_id, user.role);
}

export function readAuthAccessHelp(): AuthAccessHelpView {
  const users = listAuthUsers();
  const defaultCredentials = exposeBootstrapCredentials()
    ? authUsers
        .filter((user) => user.source === 'default')
        .map((user) => ({ user_id: user.user_id, role: user.role, password: user.password }))
    : [];

  return {
    signup_enabled: allowSelfRegister(),
    admin_signup_enabled: allowSelfRegisterAdmin(),
    users,
    default_credentials: defaultCredentials
  };
}

export function registerAuthUser(input: {
  user_id: string;
  password: string;
  role: AuthRole;
  display_name: string;
}):
  | { ok: true; user: Pick<AuthUserRecord, 'user_id' | 'role' | 'display_name'> }
  | { ok: false; error_code: string; message: string } {
  if (!allowSelfRegister()) {
    return { ok: false, error_code: 'SIGNUP_DISABLED', message: 'Self registration is disabled.' };
  }

  const userId = input.user_id.trim();
  const password = input.password;
  const displayName = input.display_name.trim();
  const role = input.role;

  if (!userId || password.length < 6 || !displayName) {
    return {
      ok: false,
      error_code: 'VALIDATION_ERROR',
      message: 'user_id, display_name and password(min 6 chars) are required.'
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

  if (findUser(userId)) {
    return {
      ok: false,
      error_code: 'USER_EXISTS',
      message: 'User already exists.'
    };
  }

  const record: AuthUserRecord = {
    user_id: userId,
    password,
    role,
    display_name: displayName,
    source: 'custom'
  };
  authUsers = [...authUsers, record];
  persistCustomUsers();

  return {
    ok: true,
    user: {
      user_id: record.user_id,
      role: record.role,
      display_name: record.display_name
    }
  };
}
