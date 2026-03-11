import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveAssignedRoleForUser } from './rbacStore.js';
import { consumePasswordResetCode, consumeSignupCode } from './authAccessCodeStore.js';
import type { AuthProvider } from '@porta/api-contracts';

type AuthRole = 'viewer' | 'operator' | 'admin' | 'auditor' | 'developer' | 'agent';
type UserSource = 'default' | 'env' | 'custom';

interface AuthUserRecord {
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
  role: AuthRole;
  display_name: string;
  avatar_url?: string;
  auth_provider?: AuthProvider | null;
  issued_at_utc: string;
  expires_at_utc: string;
  reauth_expires_at_utc: string;
}

type AuthUserPublicView = Pick<AuthUserRecord, 'account_id' | 'user_id' | 'role' | 'display_name' | 'avatar_url' | 'auth_provider'>;

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

function requireSignupCode(): boolean {
  return parseBoolean(process.env.AUTH_REQUIRE_SIGNUP_CODE, false);
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

function stableUsers(): AuthUserRecord[] {
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

function parseUserRows(raw: unknown, source: UserSource): AuthUserRecord[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const users: AuthUserRecord[] = [];
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

  const candidatePaths = new Set([usersPath, moduleUsersPath, legacyUsersPath]);
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

let authUsers: AuthUserRecord[] = loadUsers();

function persistCustomUsers(): void {
  const custom = authUsers.filter((user) => user.source === 'custom').map((user) => ({
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

function findUser(userId: string): AuthUserRecord | undefined {
  const normalized = userId.trim().toLowerCase();
  return authUsers.find((row) => row.user_id.toLowerCase() === normalized);
}

export function hasAuthUser(userId: string): boolean {
  return Boolean(findUser(userId));
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

export function issueAuthSession(user: AuthUserPublicView): { access_token: string; session: AuthSessionView } {
  cleanupExpiredSessions();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + sessionTtlMinutes() * 60_000);
  const reauthExpiresAt = new Date(issuedAt.getTime() + reauthTtlMinutes() * 60_000);
  const token = randomBytes(32).toString('base64url');
  const record: SessionRecord = {
    token,
    account_id: user.account_id,
    user_id: user.user_id,
    role: user.role,
    display_name: user.display_name,
    ...(user.avatar_url ? { avatar_url: user.avatar_url } : {}),
    ...(user.auth_provider ? { auth_provider: user.auth_provider } : {}),
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
    const changed = assignedRole !== record.role
      || record.display_name !== user.display_name
      || record.avatar_url !== user.avatar_url
      || record.account_id !== user.account_id
      || record.auth_provider !== user.auth_provider;
    if (changed) {
      record.role = assignedRole;
      record.display_name = user.display_name;
      record.account_id = user.account_id;
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

export function readAuthUserIdentity(userId: string): AuthUserIdentityView | null {
  const user = findUser(userId);
  if (!user) return null;
  return {
    account_id: user.account_id,
    user_id: user.user_id,
    role: resolveAssignedRoleForUser(user.user_id, user.role),
    display_name: user.display_name,
    ...(user.avatar_url ? { avatar_url: user.avatar_url } : {}),
    ...(user.auth_provider ? { auth_provider: user.auth_provider } : {})
  };
}

export function resolveAuthUserRole(userId: string): AuthRole | null {
  const user = findUser(userId);
  if (!user) return null;
  return resolveAssignedRoleForUser(user.user_id, user.role);
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

export function registerAuthUser(input: {
  user_id: string;
  password: string;
  role: AuthRole;
  display_name: string;
  avatar_url?: string;
  signup_code?: string;
}):
  | { ok: true; user: AuthUserPublicView }
  | { ok: false; error_code: string; message: string } {
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

  if (findUser(userId)) {
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

  const record: AuthUserRecord = {
    account_id: randomUUID(),
    user_id: userId,
    password,
    role,
    display_name: displayName,
    ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
    auth_provider: 'local',
    source: 'custom'
  };
  authUsers = [...authUsers, record];
  persistCustomUsers();

  return {
    ok: true,
    user: {
      user_id: record.user_id,
      role: record.role,
      display_name: record.display_name,
      ...(record.avatar_url ? { avatar_url: record.avatar_url } : {}),
      account_id: record.account_id,
      ...(record.auth_provider ? { auth_provider: record.auth_provider } : {})
    }
  };
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

export function updateAuthUserProfile(input: {
  user_id: string;
  display_name?: string;
  avatar_url?: string | null;
}): { ok: true; user: AuthUserPublicView } | { ok: false; error_code: string; message: string } {
  const user = findUser(input.user_id);
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
  authUsers = [...authUsers];
  persistCustomUsers();

  return {
    ok: true,
    user: {
      account_id: user.account_id,
      user_id: user.user_id,
      role: resolveAssignedRoleForUser(user.user_id, user.role),
      display_name: user.display_name,
      ...(user.avatar_url ? { avatar_url: user.avatar_url } : {}),
      ...(user.auth_provider ? { auth_provider: user.auth_provider } : {})
    }
  };
}

export function updateAuthUserPassword(input: {
  user_id: string;
  current_password: string;
  new_password: string;
}): { ok: true } | { ok: false; error_code: string; message: string } {
  const user = findUser(input.user_id);
  if (!user) {
    return { ok: false, error_code: 'USER_NOT_FOUND', message: 'User not found.' };
  }
  if (!safeEquals(user.password, input.current_password)) {
    return { ok: false, error_code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' };
  }
  if (input.new_password.length < PASSWORD_MIN) {
    return { ok: false, error_code: 'WEAK_PASSWORD', message: `New password must be at least ${PASSWORD_MIN} characters.` };
  }
  if (!/[A-Z]/.test(input.new_password) || !/[a-z]/.test(input.new_password) || !/[0-9]/.test(input.new_password)) {
    return {
      ok: false,
      error_code: 'WEAK_PASSWORD',
      message: 'New password must include uppercase, lowercase, and number.'
    };
  }
  user.password = input.new_password;
  authUsers = [...authUsers];
  persistCustomUsers();
  return { ok: true };
}

export function resetAuthUserPasswordWithCode(input: {
  user_id: string;
  reset_code: string;
  new_password: string;
}): { ok: true } | { ok: false; error_code: string; message: string } {
  const userId = input.user_id.trim();
  const resetCode = input.reset_code.trim();
  const newPassword = input.new_password;
  const user = findUser(userId);
  if (!user) {
    return { ok: false, error_code: 'USER_NOT_FOUND', message: 'User not found.' };
  }
  if (!/^\d{6}$/.test(resetCode)) {
    return { ok: false, error_code: 'INVALID_RESET_CODE', message: 'reset_code must be a 6-digit code.' };
  }
  if (newPassword.length < PASSWORD_MIN) {
    return { ok: false, error_code: 'WEAK_PASSWORD', message: `New password must be at least ${PASSWORD_MIN} characters.` };
  }
  if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
    return {
      ok: false,
      error_code: 'WEAK_PASSWORD',
      message: 'New password must include uppercase, lowercase, and number.'
    };
  }

  const consumed = consumePasswordResetCode({ code: resetCode, userId });
  if (!consumed.ok) return consumed;

  user.password = newPassword;
  authUsers = [...authUsers];
  persistCustomUsers();
  return { ok: true };
}
