import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => {
  type AuthRole = 'viewer' | 'operator' | 'admin' | 'auditor' | 'developer' | 'agent';
  type AuthProvider = 'local' | 'google' | 'microsoft' | 'sso' | null;
  type UserSource = 'default' | 'env' | 'custom';
  type StoredUserRow = {
    account_id: string;
    user_id: string;
    password_hash: string;
    password_algo: string;
    role: AuthRole;
    source: UserSource;
    display_name: string;
    avatar_url: string | null;
    auth_provider: AuthProvider;
    status: 'active' | 'suspended' | 'deleted';
    created_at: string;
    updated_at: string;
    last_login_at: string | null;
    raw_password: string;
  };

  const dbUsers = new Map<string, StoredUserRow>();
  const files = new Map<string, string>();

  function normalizePath(target: string): string {
    return String(target);
  }

  function mapStoredUser(row: StoredUserRow) {
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
      last_login_at: row.last_login_at
    };
  }

  const fsApi = {
    existsSync: vi.fn((target: string) => files.has(normalizePath(target))),
    readFileSync: vi.fn((target: string) => {
      const content = files.get(normalizePath(target));
      if (content === undefined) {
        throw new Error(`ENOENT: ${target}`);
      }
      return content;
    }),
    writeFileSync: vi.fn((target: string, content: string | Uint8Array) => {
      files.set(
        normalizePath(target),
        typeof content === 'string' ? content : Buffer.from(content).toString('utf8')
      );
    }),
    mkdirSync: vi.fn(() => undefined),
    renameSync: vi.fn((from: string, to: string) => {
      const fromPath = normalizePath(from);
      const toPath = normalizePath(to);
      const content = files.get(fromPath);
      if (content === undefined) {
        throw new Error(`ENOENT: ${from}`);
      }
      files.set(toPath, content);
      files.delete(fromPath);
    })
  };

  return {
    dbUsers,
    files,
    fsApi,
    getFleetPersistenceMode: vi.fn(() => 'postgres' as const),
    createAuthUserRecord: vi.fn(async (input: {
      account_id: string;
      user_id: string;
      password: string;
      role: AuthRole;
      source: UserSource;
      display_name: string;
      avatar_url?: string;
      auth_provider?: AuthProvider;
    }) => {
      const timestamp = '2026-03-26T12:00:00.000Z';
      const row: StoredUserRow = {
        account_id: input.account_id,
        user_id: input.user_id,
        password_hash: `hashed:${input.user_id}`,
        password_algo: 'scrypt-v1',
        role: input.role,
        source: input.source,
        display_name: input.display_name,
        avatar_url: input.avatar_url ?? null,
        auth_provider: input.auth_provider ?? null,
        status: 'active',
        created_at: timestamp,
        updated_at: timestamp,
        last_login_at: null,
        raw_password: input.password
      };
      dbUsers.set(input.user_id.toLowerCase(), row);
      return mapStoredUser(row);
    }),
    findAuthUserRecordByUserId: vi.fn(async (userId: string) => {
      const row = dbUsers.get(userId.trim().toLowerCase());
      return row ? mapStoredUser(row) : null;
    }),
    importLegacyAuthUsers: vi.fn(async (rows: Array<{ user_id: string }>) => ({ imported: 0, skipped: rows.length })),
    listAuthUserRecords: vi.fn(async () => [...dbUsers.values()].map(mapStoredUser)),
    updateAuthUserPasswordRecord: vi.fn(async () => true),
    updateAuthUserRecord: vi.fn(async () => null),
    verifyAuthUserPassword: vi.fn(async (userId: string, password: string) => {
      const row = dbUsers.get(userId.trim().toLowerCase());
      if (!row || row.raw_password !== password) {
        return null;
      }
      return mapStoredUser(row);
    }),
    createAuthSessionRecord: vi.fn(),
    findAuthSessionRecordByToken: vi.fn(async () => null),
    updateAuthSessionRecord: vi.fn(async () => null),
    revokeAuthSessionRecord: vi.fn(async () => false),
    consumePasswordResetCode: vi.fn(() => ({ ok: true })),
    consumeSignupCode: vi.fn(() => ({ ok: true })),
    resolveAssignedRoleForUser: vi.fn((userId: string, role: AuthRole) => role)
  };
});

vi.mock('node:fs', () => ({
  default: mocked.fsApi,
  ...mocked.fsApi
}));

vi.mock('node:os', () => ({
  default: { homedir: () => 'C:\\fake-home' },
  homedir: () => 'C:\\fake-home'
}));

vi.mock('../src/store/fleetPersistence.js', () => ({
  getFleetPersistenceMode: mocked.getFleetPersistenceMode
}));

vi.mock('../src/store/authUserStore.js', () => ({
  createAuthUserRecord: mocked.createAuthUserRecord,
  findAuthUserRecordByUserId: mocked.findAuthUserRecordByUserId,
  importLegacyAuthUsers: mocked.importLegacyAuthUsers,
  listAuthUserRecords: mocked.listAuthUserRecords,
  updateAuthUserPasswordRecord: mocked.updateAuthUserPasswordRecord,
  updateAuthUserRecord: mocked.updateAuthUserRecord,
  verifyAuthUserPassword: mocked.verifyAuthUserPassword
}));

vi.mock('../src/store/authSessionDbStore.js', () => ({
  createAuthSessionRecord: mocked.createAuthSessionRecord,
  findAuthSessionRecordByToken: mocked.findAuthSessionRecordByToken,
  updateAuthSessionRecord: mocked.updateAuthSessionRecord,
  revokeAuthSessionRecord: mocked.revokeAuthSessionRecord
}));

vi.mock('../src/core/authAccessCodeStore.js', () => ({
  consumePasswordResetCode: mocked.consumePasswordResetCode,
  consumeSignupCode: mocked.consumeSignupCode
}));

vi.mock('../src/core/rbacStore.js', () => ({
  resolveAssignedRoleForUser: mocked.resolveAssignedRoleForUser
}));

async function loadStore() {
  vi.resetModules();
  return import('../src/core/authSessionStore.js');
}

describe('auth compatibility rollout', () => {
  const authUsersPath = path.resolve('.tmp-auth-compat', 'auth-users.json');

  beforeEach(() => {
    mocked.dbUsers.clear();
    mocked.files.clear();
    mocked.fsApi.existsSync.mockClear();
    mocked.fsApi.readFileSync.mockClear();
    mocked.fsApi.writeFileSync.mockClear();
    mocked.fsApi.mkdirSync.mockClear();
    mocked.fsApi.renameSync.mockClear();
    mocked.createAuthUserRecord.mockClear();
    mocked.findAuthUserRecordByUserId.mockClear();
    mocked.importLegacyAuthUsers.mockClear();
    mocked.listAuthUserRecords.mockClear();
    mocked.updateAuthUserPasswordRecord.mockClear();
    mocked.updateAuthUserRecord.mockClear();
    mocked.verifyAuthUserPassword.mockClear();
    process.env.AUTH_USERS_PATH = authUsersPath;
    process.env.AUTH_COMPAT_DUAL_WRITE_LEGACY_USERS = 'true';
    process.env.AUTH_COMPAT_LEGACY_USER_FALLBACK = 'true';
    process.env.AUTH_ALLOW_SELF_REGISTER = 'true';
    delete process.env.AUTH_USERS_JSON;
  });

  it('registers custom users in postgres mode and authenticates them from a fresh module instance via the shared DB store', async () => {
    const nodeA = await loadStore();
    const created = await nodeA.registerAuthUser({
      user_id: 'cross-node@example.com',
      password: 'ValidPass1',
      role: 'developer',
      display_name: 'Cross Node'
    });

    expect(created).toEqual(expect.objectContaining({ ok: true }));
    expect(mocked.createAuthUserRecord).toHaveBeenCalledTimes(1);
    expect(mocked.files.get(authUsersPath)).toContain('"user_id": "cross-node@example.com"');

    const nodeB = await loadStore();
    const authenticated = await nodeB.authenticateUser('cross-node@example.com', 'ValidPass1');

    expect(authenticated?.user_id).toBe('cross-node@example.com');
    expect(authenticated?.display_name).toBe('Cross Node');
    expect(authenticated?.source).toBe('custom');
    expect(mocked.verifyAuthUserPassword).toHaveBeenCalledWith('cross-node@example.com', 'ValidPass1');
  });

  it('falls back to the mirrored legacy JSON store when the DB record is absent during the compatibility release', async () => {
    const nodeA = await loadStore();
    const created = await nodeA.registerAuthUser({
      user_id: 'compat@example.com',
      password: 'ValidPass1',
      role: 'developer',
      display_name: 'Compat User'
    });

    expect(created).toEqual(expect.objectContaining({ ok: true }));
    mocked.dbUsers.clear();
    mocked.verifyAuthUserPassword.mockClear();

    const nodeB = await loadStore();
    const authenticated = await nodeB.authenticateUser('compat@example.com', 'ValidPass1');

    expect(authenticated?.user_id).toBe('compat@example.com');
    expect(authenticated?.source).toBe('custom');
    expect(mocked.importLegacyAuthUsers).toHaveBeenCalled();
    expect(mocked.verifyAuthUserPassword).not.toHaveBeenCalled();
  });
});
