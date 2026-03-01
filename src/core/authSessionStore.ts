import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolveAssignedRoleForUser } from './rbacStore.js';

type AuthRole = 'viewer' | 'operator' | 'admin' | 'auditor' | 'developer' | 'agent';

interface AuthUserRecord {
  user_id: string;
  password: string;
  role: AuthRole;
  display_name: string;
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

const sessions = new Map<string, SessionRecord>();

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.trunc(parsed)) : fallback;
}

function sessionTtlMinutes(): number {
  return parsePositiveInt(process.env.AUTH_SESSION_TTL_MINUTES, 8 * 60);
}

function reauthTtlMinutes(): number {
  return parsePositiveInt(process.env.AUTH_REAUTH_TTL_MINUTES, 10);
}

function stableUsers(): AuthUserRecord[] {
  const adminPassword = process.env.AUTH_DEFAULT_ADMIN_PASSWORD ?? 'porta-admin';
  const operatorPassword = process.env.AUTH_DEFAULT_OPERATOR_PASSWORD ?? 'porta-operator';
  const auditorPassword = process.env.AUTH_DEFAULT_AUDITOR_PASSWORD ?? 'porta-auditor';
  const developerPassword = process.env.AUTH_DEFAULT_DEVELOPER_PASSWORD ?? 'porta-developer';
  return [
    { user_id: 'admin', password: adminPassword, role: 'admin', display_name: 'Admin' },
    { user_id: 'operator', password: operatorPassword, role: 'operator', display_name: 'Operator' },
    { user_id: 'auditor', password: auditorPassword, role: 'auditor', display_name: 'Auditor' },
    { user_id: 'developer', password: developerPassword, role: 'developer', display_name: 'Developer' }
  ];
}

function loadUsers(): AuthUserRecord[] {
  const raw = process.env.AUTH_USERS_JSON;
  if (!raw || raw.trim().length === 0) {
    return stableUsers();
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return stableUsers();
    }
    const users: AuthUserRecord[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      const userId = typeof row.user_id === 'string' ? row.user_id.trim() : '';
      const password = typeof row.password === 'string' ? row.password : '';
      const role = typeof row.role === 'string' ? row.role as AuthRole : 'viewer';
      const displayName = typeof row.display_name === 'string' ? row.display_name : userId;
      if (!userId || !password) continue;
      users.push({
        user_id: userId,
        password,
        role,
        display_name: displayName
      });
    }
    return users.length > 0 ? users : stableUsers();
  } catch {
    return stableUsers();
  }
}

const authUsers = loadUsers();

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

export function authenticateUser(userId: string, password: string): AuthUserRecord | null {
  const normalized = userId.trim().toLowerCase();
  const user = authUsers.find((row) => row.user_id.toLowerCase() === normalized);
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
  const user = authUsers.find((row) => row.user_id.toLowerCase() === record.user_id.toLowerCase());
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
  return authUsers.map((row) => ({
    user_id: row.user_id,
    role: resolveAssignedRoleForUser(row.user_id, row.role),
    display_name: row.display_name
  }));
}

export function resolveAuthUserRole(userId: string): AuthRole | null {
  const user = authUsers.find((row) => row.user_id.toLowerCase() === userId.trim().toLowerCase());
  if (!user) return null;
  return resolveAssignedRoleForUser(user.user_id, user.role);
}
