import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => {
  type Row = {
    account_id: string;
    user_id: string;
    password_hash: string;
    password_algo: string;
    role: 'viewer' | 'operator' | 'admin' | 'auditor' | 'developer' | 'agent';
    source: 'default' | 'env' | 'custom';
    display_name: string;
    avatar_url: string | null;
    auth_provider: 'local' | 'google' | 'microsoft' | 'sso' | null;
    status: 'active' | 'suspended' | 'deleted';
    created_at: string;
    updated_at: string;
    last_login_at: string | null;
  };

  const rows: Row[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO auth_users')) {
      const row: Row = {
        account_id: params[0] as string,
        user_id: params[1] as string,
        password_hash: params[2] as string,
        password_algo: params[3] as Row['password_algo'],
        role: params[4] as Row['role'],
        source: params[5] as Row['source'],
        display_name: params[6] as string,
        avatar_url: params[7] as string | null,
        auth_provider: params[8] as Row['auth_provider'],
        status: params[9] as Row['status'],
        created_at: params[10] as string,
        updated_at: params[11] as string,
        last_login_at: params[12] as string | null
      };
      rows.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.includes('WHERE LOWER(user_id) = LOWER($1)') && sql.includes('LIMIT 1')) {
      const userId = String(params[0] ?? '').toLowerCase();
      const row = rows.find((entry) => entry.user_id.toLowerCase() === userId);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes('FROM auth_users') && sql.includes('ORDER BY created_at ASC')) {
      return {
        rows: [...rows].sort((left, right) => left.created_at.localeCompare(right.created_at)),
        rowCount: rows.length
      };
    }

    if (sql.includes('UPDATE auth_users') && sql.includes('SET') && sql.includes('password_hash = $2')) {
      const userId = String(params[0] ?? '').toLowerCase();
      const row = rows.find((entry) => entry.user_id.toLowerCase() === userId);
      if (!row) {
        return { rows: [], rowCount: 0 };
      }
      row.password_hash = params[1] as string;
      row.password_algo = params[2] as Row['password_algo'];
      row.updated_at = params[3] as string;
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('UPDATE auth_users') && sql.includes('SET') && sql.includes('display_name = $4')) {
      const userId = String(params[0] ?? '').toLowerCase();
      const row = rows.find((entry) => entry.user_id.toLowerCase() === userId);
      if (!row) {
        return { rows: [], rowCount: 0 };
      }
      row.role = params[1] as Row['role'];
      row.source = params[2] as Row['source'];
      row.display_name = params[3] as string;
      row.avatar_url = params[4] as string | null;
      row.auth_provider = params[5] as Row['auth_provider'];
      row.status = params[6] as Row['status'];
      row.updated_at = params[7] as string;
      row.last_login_at = params[8] as string | null;
      return { rows: [row], rowCount: 1 };
    }

    throw new Error(`Unhandled query in test: ${sql}`);
  });

  return {
    rows,
    query,
    ensureFleetPersistenceReady: vi.fn(async () => undefined),
    getFleetPersistenceMode: vi.fn(() => 'postgres' as const),
    getFleetPool: vi.fn(() => ({ query }))
  };
});

vi.mock('../src/store/fleetPersistence.js', () => ({
  ensureFleetPersistenceReady: mocked.ensureFleetPersistenceReady,
  getFleetPersistenceMode: mocked.getFleetPersistenceMode,
  getFleetPool: mocked.getFleetPool
}));

import {
  createAuthUserRecord,
  findAuthUserRecordByUserId,
  importLegacyAuthUsers,
  updateAuthUserRecord,
  verifyAuthUserPassword
} from '../src/store/authUserStore.js';

describe('auth user store', () => {
  beforeEach(() => {
    mocked.rows.splice(0, mocked.rows.length);
    mocked.query.mockClear();
    mocked.ensureFleetPersistenceReady.mockClear();
    mocked.getFleetPersistenceMode.mockReturnValue('postgres');
  });

  it('creates hashed DB users and verifies passwords without storing plaintext', async () => {
    const created = await createAuthUserRecord({
      account_id: '8de80f86-1d6a-4cc8-98b9-1300e5a24c85',
      user_id: 'jane@example.com',
      password: 'ValidPass1',
      role: 'developer',
      source: 'custom',
      display_name: 'Jane Example',
      auth_provider: 'local'
    });

    expect(created).not.toBeNull();
    expect(created?.password_hash).not.toBe('ValidPass1');
    expect(created?.password_algo).toBe('scrypt-v1');

    const loaded = await findAuthUserRecordByUserId('JANE@example.com');
    expect(loaded?.display_name).toBe('Jane Example');

    const valid = await verifyAuthUserPassword('jane@example.com', 'ValidPass1');
    expect(valid?.account_id).toBe('8de80f86-1d6a-4cc8-98b9-1300e5a24c85');

    const invalid = await verifyAuthUserPassword('jane@example.com', 'WrongPass1');
    expect(invalid).toBeNull();
  });

  it('imports legacy plaintext users once and supports later profile updates', async () => {
    const imported = await importLegacyAuthUsers([
      {
        account_id: '6fbbd367-57b4-4e0f-85e4-95af6a3d5e6d',
        user_id: 'legacy@example.com',
        password: 'LegacyPass1',
        role: 'viewer',
        display_name: 'Legacy User',
        auth_provider: 'local',
        source: 'custom'
      },
      {
        account_id: '6fbbd367-57b4-4e0f-85e4-95af6a3d5e6d',
        user_id: 'legacy@example.com',
        password: 'LegacyPass1',
        role: 'viewer',
        display_name: 'Legacy User',
        auth_provider: 'local',
        source: 'custom'
      }
    ]);

    expect(imported).toEqual({ imported: 1, skipped: 1 });

    const verified = await verifyAuthUserPassword('legacy@example.com', 'LegacyPass1');
    expect(verified?.display_name).toBe('Legacy User');

    const updated = await updateAuthUserRecord({
      user_id: 'legacy@example.com',
      display_name: 'Legacy Prime',
      avatar_url: 'https://example.com/avatar.png',
      updated_at: '2026-03-25T09:00:00.000Z'
    });

    expect(updated?.display_name).toBe('Legacy Prime');
    expect(updated?.avatar_url).toBe('https://example.com/avatar.png');
  });
});
