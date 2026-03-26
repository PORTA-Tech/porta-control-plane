import { beforeEach, describe, expect, it } from 'vitest';
import type { AccountProfile } from '@porta/api-contracts';
import { clearAccountStoreForTests, upsertAccountProfile } from '../src/store/accountStore.js';
import { clearMembershipStoreForTests, upsertMembership } from '../src/store/membershipStore.js';
import { clearDeviceStoreForTests, upsertDeviceProfile } from '../src/store/deviceStore.js';
import { clearConsentRecordStoreForTests, upsertConsentRecord } from '../src/store/consentRecordStore.js';
import { clearGrowthEventStoreForTests, appendGrowthEvent, listGrowthEventsForAccount } from '../src/store/growthEventStore.js';
import {
  clearAccountActiveDayStoreForTests,
  getAccountActiveDay,
  upsertAccountActiveDay
} from '../src/store/accountActiveDayStore.js';
import { maybeActivateAccount, recordAccountActiveDay } from '../src/core/growthService.js';
import { getFleetPersistenceMode, resetFleetPersistenceForTests } from '../src/store/fleetPersistence.js';

const account: AccountProfile = {
  accountId: '03aa5b3a-83aa-42c8-bf83-ab4e6aa5d136',
  displayName: 'Growth User',
  primaryEmail: 'growth.user@example.com',
  emailVerified: true,
  avatarUrl: null,
  status: 'active',
  authProvider: 'local',
  lastLoginAt: null,
  createdAt: '2026-03-10T09:00:00.000Z',
  updatedAt: '2026-03-10T09:00:00.000Z'
};

describe('growth service', () => {
  beforeEach(async () => {
    expect(getFleetPersistenceMode()).toBe('memory');
    clearAccountStoreForTests();
    clearMembershipStoreForTests();
    clearDeviceStoreForTests();
    clearConsentRecordStoreForTests();
    clearGrowthEventStoreForTests();
    clearAccountActiveDayStoreForTests();
    await resetFleetPersistenceForTests();
  });

  it('keeps growth events append-only and idempotent by event key', async () => {
    const first = await appendGrowthEvent({
      eventKey: 'account_registered:03aa5b3a-83aa-42c8-bf83-ab4e6aa5d136',
      eventType: 'account_registered',
      accountId: account.accountId,
      userId: account.primaryEmail,
      occurredAtUtc: '2026-03-10T09:00:00.000Z',
      source: 'auth'
    });

    const second = await appendGrowthEvent({
      eventKey: 'account_registered:03aa5b3a-83aa-42c8-bf83-ab4e6aa5d136',
      eventType: 'account_registered',
      accountId: account.accountId,
      userId: account.primaryEmail,
      occurredAtUtc: '2026-03-10T09:05:00.000Z',
      source: 'auth'
    });

    expect(second.eventId).toBe(first.eventId);
    expect((await listGrowthEventsForAccount(account.accountId))).toHaveLength(1);
  });

  it('upserts account active-day facts by primary key and merges the time window', async () => {
    const first = await upsertAccountActiveDay({
      accountId: account.accountId,
      activityDate: '2026-03-11',
      firstActivityAtUtc: '2026-03-11T09:00:00.000Z',
      lastActivityAtUtc: '2026-03-11T09:00:00.000Z',
      lastMachineId: 'machine-a',
      sourceCount: 1,
      updatedAtUtc: '2026-03-11T09:00:00.000Z'
    });

    const second = await upsertAccountActiveDay({
      accountId: account.accountId,
      activityDate: '2026-03-11',
      firstActivityAtUtc: '2026-03-11T08:55:00.000Z',
      lastActivityAtUtc: '2026-03-11T09:30:00.000Z',
      lastMachineId: 'machine-b',
      sourceCount: 1,
      updatedAtUtc: '2026-03-11T09:30:00.000Z'
    });

    expect(first.activityDate).toBe('2026-03-11');
    expect(second.firstActivityAtUtc).toBe('2026-03-11T08:55:00.000Z');
    expect(second.lastActivityAtUtc).toBe('2026-03-11T09:30:00.000Z');
    expect(second.lastMachineId).toBe('machine-b');
    expect(second.sourceCount).toBe(2);

    const persisted = await getAccountActiveDay(account.accountId, '2026-03-11');
    expect(persisted?.sourceCount).toBe(2);
    expect(persisted?.lastMachineId).toBe('machine-b');
  });

  it('activates an eligible account only once after membership, linked device, consent, and active day exist', async () => {
    await upsertAccountProfile(account);

    expect(await maybeActivateAccount(account.accountId)).toBeNull();

    await upsertMembership({
      membershipId: '70d5e746-582d-4edb-9fb6-10ec5476e5f7',
      accountId: account.accountId,
      orgId: 'f7c3e85f-435f-421a-b768-adf47c1295ab',
      role: 'owner',
      status: 'active',
      invitedAt: '2026-03-10T09:15:00.000Z',
      joinedAt: '2026-03-10T09:20:00.000Z',
      invitedByAccountId: null,
      createdAt: '2026-03-10T09:15:00.000Z',
      updatedAt: '2026-03-10T09:20:00.000Z'
    });

    await upsertDeviceProfile({
      deviceId: '1b433a91-f161-4701-bcf4-789f2adce4b1',
      orgId: 'f7c3e85f-435f-421a-b768-adf47c1295ab',
      machineName: 'DESKTOP-PORTA',
      deviceDisplayName: 'Growth Workstation',
      platform: 'windows',
      agentVersion: '1.0.0',
      status: 'active',
      firstSeenAt: '2026-03-10T09:00:00.000Z',
      lastSeenAt: '2026-03-11T09:05:00.000Z',
      currentAccountId: account.accountId,
      revokedAt: null,
      createdAt: '2026-03-10T09:00:00.000Z',
      updatedAt: '2026-03-11T09:05:00.000Z'
    });

    await upsertConsentRecord({
      consentId: '8f07ef80-6739-4218-8273-32ac222f1b89',
      scope: 'device_capture',
      accountId: account.accountId,
      deviceId: '1b433a91-f161-4701-bcf4-789f2adce4b1',
      orgId: 'f7c3e85f-435f-421a-b768-adf47c1295ab',
      consentVersion: 'v1',
      consentState: 'accepted',
      telemetryLevel: 'enhanced',
      consentedAt: '2026-03-11T09:06:00.000Z',
      updatedAt: '2026-03-11T09:06:00.000Z'
    });

    expect(await maybeActivateAccount(account.accountId)).toBeNull();

    const recorded = await recordAccountActiveDay({
      accountId: account.accountId,
      activityAtUtc: '2026-03-11T09:07:00.000Z',
      machineId: 'machine-a',
      orgId: 'f7c3e85f-435f-421a-b768-adf47c1295ab',
      source: 'telemetry'
    });

    expect(recorded.activeDay.activityDate).toBe('2026-03-11');
    expect(recorded.event.eventType).toBe('account_active_day');

    const activated = await maybeActivateAccount(account.accountId);
    expect(activated?.eventType).toBe('account_activated');
    expect(activated?.accountId).toBe(account.accountId);
    expect(activated?.userId).toBe(account.primaryEmail);

    const second = await maybeActivateAccount(account.accountId);
    expect(second?.eventId).toBe(activated?.eventId);

    const events = await listGrowthEventsForAccount(account.accountId);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining(['account_active_day', 'account_activated']));
  });
});
