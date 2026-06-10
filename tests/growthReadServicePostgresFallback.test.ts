import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountProfile } from '@porta/api-contracts';

const mocks = vi.hoisted(() => ({
  listAuthUserRecords: vi.fn(),
  listAccountProfiles: vi.fn(),
  listGrowthEvents: vi.fn(),
  listGrowthEventsForAccount: vi.fn(),
  listAccountActiveDays: vi.fn(),
  listAccountActiveDaysForAccount: vi.fn(),
  listMachineSummaries: vi.fn()
}));

vi.mock('../src/store/fleetPersistence.js', () => ({
  getFleetPersistenceMode: () => 'postgres'
}));

vi.mock('../src/store/authUserStore.js', () => ({
  listAuthUserRecords: mocks.listAuthUserRecords
}));

vi.mock('../src/store/accountStore.js', () => ({
  listAccountProfiles: mocks.listAccountProfiles
}));

vi.mock('../src/store/growthEventStore.js', () => ({
  listGrowthEvents: mocks.listGrowthEvents,
  listGrowthEventsForAccount: mocks.listGrowthEventsForAccount
}));

vi.mock('../src/store/accountActiveDayStore.js', () => ({
  listAccountActiveDays: mocks.listAccountActiveDays,
  listAccountActiveDaysForAccount: mocks.listAccountActiveDaysForAccount
}));

vi.mock('../src/store/machineSummaryStore.js', () => ({
  listMachineSummaries: mocks.listMachineSummaries
}));

vi.mock('../src/core/authSessionStore.js', () => ({
  readAuthUserIdentity: vi.fn()
}));

import { readGrowthSummary } from '../src/core/growthReadService.js';

describe('growth read service postgres fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAuthUserRecords.mockResolvedValue([]);
    mocks.listGrowthEvents.mockResolvedValue([]);
    mocks.listGrowthEventsForAccount.mockResolvedValue([]);
    mocks.listAccountActiveDays.mockResolvedValue([]);
    mocks.listAccountActiveDaysForAccount.mockResolvedValue([]);
    mocks.listMachineSummaries.mockResolvedValue([]);
  });

  it('falls back to self-serve account profiles when auth_users has not been backfilled yet', async () => {
    const recent = new Date();
    recent.setUTCDate(recent.getUTCDate() - 1);

    const accounts: AccountProfile[] = [
      {
        accountId: 'b64d5c29-2503-47c0-b82f-2f652ff5bb17',
        displayName: 'Real User',
        primaryEmail: 'real.user@example.com',
        emailVerified: true,
        avatarUrl: null,
        status: 'active',
        authProvider: 'local',
        lastLoginAt: null,
        createdAt: recent.toISOString(),
        updatedAt: recent.toISOString()
      },
      {
        accountId: '5ca66dd0-1530-4eca-b3db-1dff77f9f222',
        displayName: 'Seed User',
        primaryEmail: 'operator',
        emailVerified: false,
        avatarUrl: null,
        status: 'active',
        authProvider: 'local',
        lastLoginAt: null,
        createdAt: recent.toISOString(),
        updatedAt: recent.toISOString()
      }
    ];
    mocks.listAccountProfiles.mockResolvedValue(accounts);

    const summary = await readGrowthSummary(30);

    expect(summary.totalRegisteredUsers).toBe(1);
    expect(summary.newRegisteredUsers).toBe(1);
    expect(summary.activatedUsers).toBe(0);
    expect(summary.totalInstalls).toBe(0);
    expect(summary.unlinkedMachines).toBe(0);
  });
});
