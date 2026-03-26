import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findAuthUserRecordByUserId: vi.fn(),
  getAccountProfile: vi.fn()
}));

vi.mock('../src/store/fleetPersistence.js', () => ({
  getFleetPersistenceMode: () => 'postgres'
}));

vi.mock('../src/store/authUserStore.js', () => ({
  findAuthUserRecordByUserId: mocks.findAuthUserRecordByUserId
}));

vi.mock('../src/store/accountStore.js', () => ({
  getAccountProfile: mocks.getAccountProfile
}));

vi.mock('../src/store/membershipStore.js', () => ({
  listMembershipsForAccount: vi.fn()
}));

vi.mock('../src/store/deviceStore.js', () => ({
  listDeviceProfilesForAccount: vi.fn()
}));

vi.mock('../src/store/consentRecordStore.js', () => ({
  listConsentRecordsForAccount: vi.fn()
}));

vi.mock('../src/store/growthEventStore.js', () => ({
  appendGrowthEvent: vi.fn(),
  getGrowthEventByKey: vi.fn()
}));

vi.mock('../src/store/accountActiveDayStore.js', () => ({
  listAccountActiveDaysForAccount: vi.fn(),
  upsertAccountActiveDay: vi.fn()
}));

import { shouldTrackGrowthAccount } from '../src/core/growthService.js';

describe('growth service postgres fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tracks email-based self-serve accounts when auth_users is still missing', async () => {
    mocks.findAuthUserRecordByUserId.mockResolvedValue(null);
    mocks.getAccountProfile.mockResolvedValue({
      accountId: '73863eeb-911f-41d4-b3d8-718f1a94fb7f',
      primaryEmail: 'fallback.user@example.com'
    });

    await expect(shouldTrackGrowthAccount('73863eeb-911f-41d4-b3d8-718f1a94fb7f')).resolves.toBe(true);
  });

  it('still rejects non-email bootstrap identities when auth_users is missing', async () => {
    mocks.findAuthUserRecordByUserId.mockResolvedValue(null);
    mocks.getAccountProfile.mockResolvedValue({
      accountId: '81f3f56a-181f-4366-b03a-0e8b964999fd',
      primaryEmail: 'operator'
    });

    await expect(shouldTrackGrowthAccount('81f3f56a-181f-4366-b03a-0e8b964999fd')).resolves.toBe(false);
  });
});
