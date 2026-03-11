import { beforeEach, describe, expect, it } from 'vitest';
import type { AccountProfile, ConsentRecord, DeviceProfile, Membership, OrganizationProfile } from '@porta/api-contracts';
import { clearAccountStoreForTests, deleteAccountProfile, getAccountProfile, getAccountProfileByPrimaryEmail, listAccountProfiles, upsertAccountProfile } from '../src/store/accountStore.js';
import { clearOrganizationStoreForTests, deleteOrganizationProfile, getOrganizationProfile, listOrganizationProfiles, upsertOrganizationProfile } from '../src/store/organizationStore.js';
import { clearMembershipStoreForTests, deleteMembership, getMembership, listMembershipsForAccount, listMembershipsForOrganization, upsertMembership } from '../src/store/membershipStore.js';
import { clearDeviceStoreForTests, deleteDeviceProfile, getDeviceProfile, listDeviceProfilesForAccount, listDeviceProfilesForOrganization, upsertDeviceProfile } from '../src/store/deviceStore.js';
import { clearConsentRecordStoreForTests, deleteConsentRecord, getConsentRecord, listConsentRecordsForAccount, listConsentRecordsForDevice, listConsentRecordsForOrganization, upsertConsentRecord } from '../src/store/consentRecordStore.js';
import { getFleetPersistenceMode, resetFleetPersistenceForTests } from '../src/store/fleetPersistence.js';

const account: AccountProfile = {
  accountId: '03aa5b3a-83aa-42c8-bf83-ab4e6aa5d136',
  displayName: 'Harold Porter',
  primaryEmail: 'harold@example.com',
  emailVerified: true,
  avatarUrl: null,
  status: 'active',
  authProvider: 'local',
  lastLoginAt: '2026-03-11T09:00:00.000Z',
  createdAt: '2026-03-10T09:00:00.000Z',
  updatedAt: '2026-03-11T09:00:00.000Z'
};

const organization: OrganizationProfile = {
  orgId: 'f7c3e85f-435f-421a-b768-adf47c1295ab',
  orgName: 'PORTA Labs',
  orgSlug: 'porta-labs',
  planTier: 'pro',
  billingAccountId: 'billing_123',
  createdAt: '2026-03-10T09:00:00.000Z',
  updatedAt: '2026-03-11T09:00:00.000Z'
};

const membership: Membership = {
  membershipId: '70d5e746-582d-4edb-9fb6-10ec5476e5f7',
  accountId: account.accountId,
  orgId: organization.orgId,
  role: 'admin',
  status: 'active',
  invitedAt: '2026-03-10T09:15:00.000Z',
  joinedAt: '2026-03-10T09:20:00.000Z',
  invitedByAccountId: null,
  createdAt: '2026-03-10T09:15:00.000Z',
  updatedAt: '2026-03-11T09:00:00.000Z'
};

const device: DeviceProfile = {
  deviceId: '1b433a91-f161-4701-bcf4-789f2adce4b1',
  orgId: organization.orgId,
  machineName: 'DESKTOP-PORTA',
  deviceDisplayName: 'Harold Workstation',
  platform: 'windows',
  agentVersion: '1.0.0',
  status: 'active',
  firstSeenAt: '2026-03-10T09:00:00.000Z',
  lastSeenAt: '2026-03-11T09:05:00.000Z',
  currentAccountId: account.accountId,
  revokedAt: null,
  createdAt: '2026-03-10T09:00:00.000Z',
  updatedAt: '2026-03-11T09:05:00.000Z'
};

const consentRecord: ConsentRecord = {
  consentId: '8f07ef80-6739-4218-8273-32ac222f1b89',
  scope: 'device_capture',
  accountId: account.accountId,
  deviceId: device.deviceId,
  orgId: organization.orgId,
  consentVersion: 'v1',
  consentState: 'accepted',
  telemetryLevel: 'enhanced',
  consentedAt: '2026-03-10T09:30:00.000Z',
  updatedAt: '2026-03-11T09:06:00.000Z'
};

describe('identity stores', () => {
  beforeEach(async () => {
    expect(getFleetPersistenceMode()).toBe('memory');
    clearAccountStoreForTests();
    clearOrganizationStoreForTests();
    clearMembershipStoreForTests();
    clearDeviceStoreForTests();
    clearConsentRecordStoreForTests();
    await resetFleetPersistenceForTests();
  });

  it('upserts, reads, lists, and deletes account profiles', async () => {
    await upsertAccountProfile(account);

    expect((await getAccountProfile(account.accountId))?.displayName).toBe('Harold Porter');
    expect((await getAccountProfileByPrimaryEmail(account.primaryEmail))?.accountId).toBe(account.accountId);
    expect((await listAccountProfiles()).map((entry) => entry.accountId)).toEqual([account.accountId]);

    await deleteAccountProfile(account.accountId);
    expect(await getAccountProfile(account.accountId)).toBeNull();
  });

  it('upserts, reads, lists, and deletes organization profiles', async () => {
    await upsertOrganizationProfile(organization);

    expect((await getOrganizationProfile(organization.orgId))?.orgName).toBe('PORTA Labs');
    expect((await listOrganizationProfiles()).map((entry) => entry.orgId)).toEqual([organization.orgId]);

    await deleteOrganizationProfile(organization.orgId);
    expect(await getOrganizationProfile(organization.orgId)).toBeNull();
  });

  it('upserts, filters, and deletes memberships', async () => {
    await upsertMembership(membership);

    expect((await getMembership(membership.membershipId))?.role).toBe('admin');
    expect((await listMembershipsForAccount(account.accountId)).map((entry) => entry.membershipId)).toEqual([membership.membershipId]);
    expect((await listMembershipsForOrganization(organization.orgId)).map((entry) => entry.membershipId)).toEqual([membership.membershipId]);

    await deleteMembership(membership.membershipId);
    expect(await getMembership(membership.membershipId)).toBeNull();
  });

  it('upserts, filters, and deletes device profiles', async () => {
    await upsertDeviceProfile(device);

    expect((await getDeviceProfile(device.deviceId))?.deviceDisplayName).toBe('Harold Workstation');
    expect((await listDeviceProfilesForAccount(account.accountId)).map((entry) => entry.deviceId)).toEqual([device.deviceId]);
    expect((await listDeviceProfilesForOrganization(organization.orgId)).map((entry) => entry.deviceId)).toEqual([device.deviceId]);

    await deleteDeviceProfile(device.deviceId);
    expect(await getDeviceProfile(device.deviceId)).toBeNull();
  });

  it('upserts, filters, and deletes consent records', async () => {
    await upsertConsentRecord(consentRecord);

    expect((await getConsentRecord(consentRecord.consentId))?.consentState).toBe('accepted');
    expect((await listConsentRecordsForAccount(account.accountId)).map((entry) => entry.consentId)).toEqual([consentRecord.consentId]);
    expect((await listConsentRecordsForDevice(device.deviceId)).map((entry) => entry.consentId)).toEqual([consentRecord.consentId]);
    expect((await listConsentRecordsForOrganization(organization.orgId)).map((entry) => entry.consentId)).toEqual([consentRecord.consentId]);

    await deleteConsentRecord(consentRecord.consentId);
    expect(await getConsentRecord(consentRecord.consentId)).toBeNull();
  });
});
