import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => {
  type SessionRow = {
    session_id: string;
    account_id: string;
    user_id: string;
    role: 'viewer' | 'operator' | 'admin' | 'auditor' | 'developer' | 'agent';
    display_name: string;
    avatar_url?: string;
    auth_provider?: 'local' | 'google' | 'microsoft' | 'sso' | null;
    session_type: 'access' | 'refresh';
    refresh_family_id?: string | null;
    issued_at_utc: string;
    expires_at_utc: string;
    reauth_expires_at_utc: string;
    revoked_at_utc?: string | null;
    created_at_utc: string;
    updated_at_utc: string;
  };

  const sessions = new Map<string, SessionRow>();
  let nextId = 1;

  return {
    sessions,
    nextId: () => `session-${nextId++}`,
    getFleetPersistenceMode: vi.fn(() => 'postgres' as const),
    createAuthSessionRecord: vi.fn(async (input: {
      token: string;
      account_id: string;
      user_id: string;
      role: SessionRow['role'];
      display_name: string;
      avatar_url?: string;
      auth_provider?: SessionRow['auth_provider'];
      session_type?: SessionRow['session_type'];
      refresh_family_id?: string | null;
      issued_at_utc: string;
      expires_at_utc: string;
      reauth_expires_at_utc: string;
    }) => {
      const row: SessionRow = {
        session_id: `session-${nextId++}`,
        account_id: input.account_id,
        user_id: input.user_id,
        role: input.role,
        display_name: input.display_name,
        ...(input.avatar_url ? { avatar_url: input.avatar_url } : {}),
        ...(input.auth_provider ? { auth_provider: input.auth_provider } : {}),
        session_type: input.session_type ?? 'access',
        refresh_family_id: input.refresh_family_id ?? null,
        issued_at_utc: input.issued_at_utc,
        expires_at_utc: input.expires_at_utc,
        reauth_expires_at_utc: input.reauth_expires_at_utc,
        revoked_at_utc: null,
        created_at_utc: input.issued_at_utc,
        updated_at_utc: input.issued_at_utc
      };
      sessions.set(input.token, row);
      return row;
    }),
    findAuthSessionRecordByToken: vi.fn(async (token: string) => sessions.get(token) ?? null),
    updateAuthSessionRecord: vi.fn(async (input: {
      session_id: string;
      account_id?: string;
      role?: SessionRow['role'];
      display_name?: string;
      avatar_url?: string | null;
      auth_provider?: SessionRow['auth_provider'];
      reauth_expires_at_utc?: string;
      updated_at_utc?: string;
    }) => {
      const entry = [...sessions.entries()].find(([, value]) => value.session_id === input.session_id);
      if (!entry) {
        return null;
      }
      const [token, row] = entry;
      if (input.account_id !== undefined) row.account_id = input.account_id;
      if (input.role !== undefined) row.role = input.role;
      if (input.display_name !== undefined) row.display_name = input.display_name;
      if (input.avatar_url !== undefined) {
        if (input.avatar_url) {
          row.avatar_url = input.avatar_url;
        } else {
          delete row.avatar_url;
        }
      }
      if (input.auth_provider !== undefined) {
        if (input.auth_provider) {
          row.auth_provider = input.auth_provider;
        } else {
          delete row.auth_provider;
        }
      }
      if (input.reauth_expires_at_utc !== undefined) row.reauth_expires_at_utc = input.reauth_expires_at_utc;
      row.updated_at_utc = input.updated_at_utc ?? row.updated_at_utc;
      sessions.set(token, row);
      return row;
    }),
    revokeAuthSessionRecord: vi.fn(async (token: string, revokedAtUtc: string) => {
      const row = sessions.get(token);
      if (!row) {
        return false;
      }
      row.revoked_at_utc = revokedAtUtc;
      row.updated_at_utc = revokedAtUtc;
      sessions.set(token, row);
      return true;
    }),
    revokeAuthSessionFamilyRecords: vi.fn(async (refreshFamilyId: string, revokedAtUtc: string) => {
      let revoked = 0;
      for (const [token, row] of sessions.entries()) {
        if (row.refresh_family_id === refreshFamilyId && !row.revoked_at_utc) {
          row.revoked_at_utc = revokedAtUtc;
          row.updated_at_utc = revokedAtUtc;
          sessions.set(token, row);
          revoked += 1;
        }
      }
      return revoked;
    }),
    createAuthUserRecord: vi.fn(),
    findAuthUserRecordByUserId: vi.fn(async () => null),
    importLegacyAuthUsers: vi.fn(async () => ({ imported: 0, skipped: 0 })),
    listAuthUserRecords: vi.fn(async () => []),
    updateAuthUserPasswordRecord: vi.fn(async () => true),
    updateAuthUserRecord: vi.fn(async () => null),
    verifyAuthUserPassword: vi.fn(async () => null),
    consumePasswordResetCode: vi.fn(() => ({ ok: true })),
    consumeSignupCode: vi.fn(() => ({ ok: true })),
    resolveAssignedRoleForUser: vi.fn((userId: string, role: SessionRow['role']) => role)
  };
});

vi.mock('../src/store/fleetPersistence.js', () => ({
  getFleetPersistenceMode: mocked.getFleetPersistenceMode
}));

vi.mock('../src/store/authSessionDbStore.js', () => ({
  createAuthSessionRecord: mocked.createAuthSessionRecord,
  findAuthSessionRecordByToken: mocked.findAuthSessionRecordByToken,
  updateAuthSessionRecord: mocked.updateAuthSessionRecord,
  revokeAuthSessionRecord: mocked.revokeAuthSessionRecord,
  revokeAuthSessionFamilyRecords: mocked.revokeAuthSessionFamilyRecords
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

vi.mock('../src/core/authAccessCodeStore.js', () => ({
  consumePasswordResetCode: mocked.consumePasswordResetCode,
  consumeSignupCode: mocked.consumeSignupCode
}));

vi.mock('../src/core/rbacStore.js', () => ({
  resolveAssignedRoleForUser: mocked.resolveAssignedRoleForUser
}));

import {
  clearAuthSessionStoreForTests,
  issueAuthSession,
  readAuthSession
} from '../src/core/authSessionStore.js';

describe('auth session store facade', () => {
  beforeEach(() => {
    mocked.sessions.clear();
    mocked.createAuthSessionRecord.mockClear();
    mocked.findAuthSessionRecordByToken.mockClear();
    mocked.updateAuthSessionRecord.mockClear();
    mocked.revokeAuthSessionRecord.mockClear();
    mocked.findAuthUserRecordByUserId.mockReset();
    mocked.findAuthUserRecordByUserId.mockResolvedValue(null);
    clearAuthSessionStoreForTests();
  });

  it('reads postgres sessions from the shared store after local memory is cleared', async () => {
    const issued = await issueAuthSession({
      account_id: '3de5c660-c2f4-4142-adbc-d8bf0217c2e0',
      user_id: 'admin',
      base_role: 'admin',
      role: 'admin',
      display_name: 'Admin',
      auth_provider: 'local',
      source: 'default'
    });

    const stored = mocked.sessions.get(issued.access_token);
    expect(stored).toBeDefined();

    stored!.display_name = 'Stale Name';
    stored!.role = 'viewer';
    mocked.sessions.set(issued.access_token, stored!);

    clearAuthSessionStoreForTests();

    // Reconciliation must re-derive the identity from the shared (postgres) user
    // store, not the stale session row. Seed that store directly — this is the real
    // production path (findAuthUserRecordByUserId), and keeps the test independent of
    // the dev-only built-in user table, which is off in production and under the
    // singleThread runner shares process.env with other suites.
    mocked.findAuthUserRecordByUserId.mockResolvedValue({
      account_id: '3de5c660-c2f4-4142-adbc-d8bf0217c2e0',
      user_id: 'admin',
      password_hash: 'unused-in-this-path',
      password_algo: 'scrypt',
      role: 'admin',
      source: 'custom',
      display_name: 'Admin',
      auth_provider: 'local',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      last_login_at: null
    });

    const session = await readAuthSession(issued.access_token);
    expect(session?.user_id).toBe('admin');
    expect(session?.display_name).toBe('Admin');
    expect(session?.role).toBe('admin');
    expect(mocked.findAuthSessionRecordByToken).toHaveBeenCalledWith(issued.access_token);
    expect(mocked.updateAuthSessionRecord).toHaveBeenCalled();
  });
});
