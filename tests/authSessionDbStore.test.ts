import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => {
  type Row = {
    session_id: string;
    token_hash: string;
    account_id: string;
    user_id: string;
    role: 'viewer' | 'operator' | 'admin' | 'auditor' | 'developer' | 'agent';
    display_name: string;
    avatar_url: string | null;
    auth_provider: 'local' | 'google' | 'microsoft' | 'sso' | null;
    issued_at_utc: string;
    expires_at_utc: string;
    reauth_expires_at_utc: string;
    revoked_at_utc: string | null;
    created_at_utc: string;
    updated_at_utc: string;
  };

  const rows: Row[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO auth_sessions')) {
      const row: Row = {
        session_id: params[0] as string,
        token_hash: params[1] as string,
        account_id: params[2] as string,
        user_id: params[3] as string,
        role: params[4] as Row['role'],
        display_name: params[5] as string,
        avatar_url: params[6] as string | null,
        auth_provider: params[7] as Row['auth_provider'],
        issued_at_utc: params[8] as string,
        expires_at_utc: params[9] as string,
        reauth_expires_at_utc: params[10] as string,
        revoked_at_utc: null,
        created_at_utc: params[11] as string,
        updated_at_utc: params[12] as string
      };
      rows.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.includes('FROM auth_sessions') && sql.includes('WHERE token_hash = $1') && sql.includes('LIMIT 1')) {
      const row = rows.find((entry) => entry.token_hash === params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes('FROM auth_sessions') && sql.includes('WHERE session_id = $1::uuid')) {
      const row = rows.find((entry) => entry.session_id === params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes('UPDATE auth_sessions') && sql.includes('WHERE session_id = $1::uuid')) {
      const row = rows.find((entry) => entry.session_id === params[0]);
      if (!row) {
        return { rows: [], rowCount: 0 };
      }
      row.account_id = params[1] as string;
      row.role = params[2] as Row['role'];
      row.display_name = params[3] as string;
      row.avatar_url = params[4] as string | null;
      row.auth_provider = params[5] as Row['auth_provider'];
      row.issued_at_utc = params[6] as string;
      row.expires_at_utc = params[7] as string;
      row.reauth_expires_at_utc = params[8] as string;
      row.revoked_at_utc = params[9] as string | null;
      row.updated_at_utc = params[10] as string;
      return { rows: [row], rowCount: 1 };
    }

    if (sql.includes('UPDATE auth_sessions') && sql.includes('WHERE token_hash = $1')) {
      const row = rows.find((entry) => entry.token_hash === params[0] && entry.revoked_at_utc === null);
      if (!row) {
        return { rows: [], rowCount: 0 };
      }
      row.revoked_at_utc = params[1] as string;
      row.updated_at_utc = params[1] as string;
      return { rows: [], rowCount: 1 };
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
  createAuthSessionRecord,
  findAuthSessionRecordByToken,
  hashAuthSessionToken,
  revokeAuthSessionRecord,
  updateAuthSessionRecord
} from '../src/store/authSessionDbStore.js';

describe('auth session db store', () => {
  beforeEach(() => {
    mocked.rows.splice(0, mocked.rows.length);
    mocked.query.mockClear();
  });

  it('persists only the token hash and supports token lookup', async () => {
    const token = 'raw-token-value';
    const created = await createAuthSessionRecord({
      token,
      account_id: '11f29c68-2b27-44e0-a492-125fd7908064',
      user_id: 'jane@example.com',
      role: 'developer',
      display_name: 'Jane Example',
      auth_provider: 'local',
      issued_at_utc: '2026-03-26T08:00:00.000Z',
      expires_at_utc: '2026-03-27T08:00:00.000Z',
      reauth_expires_at_utc: '2026-03-26T08:10:00.000Z'
    });

    expect(created).not.toBeNull();
    expect(mocked.rows[0]?.token_hash).toBe(hashAuthSessionToken(token));
    expect(mocked.rows[0]?.token_hash).not.toBe(token);

    const loaded = await findAuthSessionRecordByToken(token);
    expect(loaded?.user_id).toBe('jane@example.com');
    expect(loaded?.display_name).toBe('Jane Example');
  });

  it('updates snapshot fields and revokes sessions by token hash', async () => {
    const token = 'another-raw-token';
    const created = await createAuthSessionRecord({
      token,
      account_id: '906ab65a-ae54-497f-bcbf-22b361e61371',
      user_id: 'admin',
      role: 'admin',
      display_name: 'Admin',
      auth_provider: 'local',
      issued_at_utc: '2026-03-26T08:00:00.000Z',
      expires_at_utc: '2026-03-27T08:00:00.000Z',
      reauth_expires_at_utc: '2026-03-26T08:10:00.000Z'
    });

    const updated = await updateAuthSessionRecord({
      session_id: created!.session_id,
      display_name: 'Admin Prime',
      reauth_expires_at_utc: '2026-03-26T08:20:00.000Z',
      updated_at_utc: '2026-03-26T08:05:00.000Z'
    });

    expect(updated?.display_name).toBe('Admin Prime');
    expect(updated?.reauth_expires_at_utc).toBe('2026-03-26T08:20:00.000Z');

    const revoked = await revokeAuthSessionRecord(token, '2026-03-26T08:06:00.000Z');
    expect(revoked).toBe(true);

    const loaded = await findAuthSessionRecordByToken(token);
    expect(loaded?.revoked_at_utc).toBe('2026-03-26T08:06:00.000Z');
  });
});
