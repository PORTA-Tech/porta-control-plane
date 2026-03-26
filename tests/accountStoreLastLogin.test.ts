import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountProfile } from '@porta/api-contracts';

const mocked = vi.hoisted(() => {
  type Row = {
    payload_json: AccountProfile;
    last_login_at: string | null;
    updated_at: string;
  };

  const rows = new Map<string, Row>();
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT payload_json') && sql.includes('FROM accounts')) {
      const accountId = String(params[0] ?? '');
      const row = rows.get(accountId);
      return {
        rows: row ? [{ payload_json: row.payload_json }] : [],
        rowCount: row ? 1 : 0
      };
    }

    if (sql.includes('UPDATE accounts') && sql.includes('last_login_at = $2::timestamptz')) {
      const accountId = String(params[0] ?? '');
      const row = rows.get(accountId);
      if (!row) {
        return { rows: [], rowCount: 0 };
      }

      row.last_login_at = params[1] as string;
      row.payload_json = JSON.parse(String(params[2] ?? 'null')) as AccountProfile;
      row.updated_at = params[3] as string;
      rows.set(accountId, row);
      return {
        rows: [{ payload_json: row.payload_json }],
        rowCount: 1
      };
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

import { touchAccountLastLogin } from '../src/store/accountStore.js';

describe('account store last login touch', () => {
  beforeEach(() => {
    mocked.rows.clear();
    mocked.query.mockClear();
    mocked.ensureFleetPersistenceReady.mockClear();
    mocked.getFleetPool.mockClear();
    mocked.getFleetPersistenceMode.mockReturnValue('postgres');
  });

  it('updates the scalar last_login_at, payload_json.lastLoginAt, and updated_at together', async () => {
    mocked.rows.set('03aa5b3a-83aa-42c8-bf83-ab4e6aa5d136', {
      payload_json: {
        accountId: '03aa5b3a-83aa-42c8-bf83-ab4e6aa5d136',
        displayName: 'Harold Porter',
        primaryEmail: 'harold@example.com',
        emailVerified: true,
        avatarUrl: null,
        status: 'active',
        authProvider: 'local',
        lastLoginAt: null,
        createdAt: '2026-03-10T09:00:00.000Z',
        updatedAt: '2026-03-11T09:00:00.000Z'
      },
      last_login_at: null,
      updated_at: '2026-03-11T09:00:00.000Z'
    });

    const touchedAt = '2026-03-26T12:34:56.000Z';
    const updated = await touchAccountLastLogin('03aa5b3a-83aa-42c8-bf83-ab4e6aa5d136', touchedAt);

    expect(updated?.lastLoginAt).toBe(touchedAt);
    expect(updated?.updatedAt).toBe(touchedAt);

    const persisted = mocked.rows.get('03aa5b3a-83aa-42c8-bf83-ab4e6aa5d136');
    expect(persisted?.last_login_at).toBe(touchedAt);
    expect(persisted?.updated_at).toBe(touchedAt);
    expect(persisted?.payload_json.lastLoginAt).toBe(touchedAt);
    expect(persisted?.payload_json.updatedAt).toBe(touchedAt);
  });
});
