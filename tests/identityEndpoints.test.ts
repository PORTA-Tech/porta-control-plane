import * as fs from 'node:fs';
import * as path from 'node:path';
import * as supertest from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetSLOGateStateForTests } from '../src/core/sloEvaluator.js';
import { clearGrowthEventStoreForTests, listGrowthEventsForAccount } from '../src/store/growthEventStore.js';
import { loadRuntimeState, resetRuntimeStateForTests } from '../src/store/runtimeState.js';
import { clearAccountStoreForTests, getAccountProfile } from '../src/store/accountStore.js';
import { clearAccountActiveDayStoreForTests } from '../src/store/accountActiveDayStore.js';
import { clearOrganizationStoreForTests, upsertOrganizationProfile } from '../src/store/organizationStore.js';
import { clearMembershipStoreForTests, upsertMembership } from '../src/store/membershipStore.js';
import { clearDeviceStoreForTests, upsertDeviceProfile } from '../src/store/deviceStore.js';
import { clearConsentRecordStoreForTests, upsertConsentRecord } from '../src/store/consentRecordStore.js';
import { reloadBaseUsersForTests } from '../src/core/authSessionStore.js';

// This suite signs in through the built-in admin login, which is now dev-only and
// off by default. Opt in explicitly, the way a developer would locally.
process.env.PORTA_ENABLE_DEFAULT_LOGINS = 'true';
reloadBaseUsersForTests();

const dataDir = path.resolve('.data');
const request = (supertest as unknown as { default: typeof supertest }).default as unknown as typeof import('supertest');
const app = createApp();

async function loginAdmin(): Promise<string> {
  const response = await request(app).post('/auth/login').send({
    user_id: 'admin',
    password: 'porta-admin'
  });

  expect(response.status).toBe(200);
  expect(typeof response.body.access_token).toBe('string');
  return response.body.access_token as string;
}

describe('identity endpoints', () => {
  beforeEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    resetRuntimeStateForTests();
    resetSLOGateStateForTests();
    clearAccountStoreForTests();
    clearGrowthEventStoreForTests();
    clearAccountActiveDayStoreForTests();
    clearOrganizationStoreForTests();
    clearMembershipStoreForTests();
    clearDeviceStoreForTests();
    clearConsentRecordStoreForTests();
    loadRuntimeState();
  });

  it('serves /v1/me, organizations, devices, profile update, and revoke without telemetry', async () => {
    const token = await loginAdmin();

    const meResponse = await request(app).get('/v1/me').set('authorization', `Bearer ${token}`);
    expect(meResponse.status).toBe(200);
    expect(meResponse.body.account.displayName).toBe('Admin');
    expect(meResponse.body.consents).toHaveLength(1);
    expect(meResponse.body.consents[0]?.scope).toBe('account_legal');
    expect(meResponse.body.consents[0]?.consentState).toBe('accepted');
    const accountId = meResponse.body.account.accountId as string;

    await upsertOrganizationProfile({
      orgId: '4d69d34a-1ec8-4c60-bf02-7e1fe63fe0ed',
      orgName: 'PORTA Labs',
      orgSlug: 'porta-labs',
      planTier: 'pro',
      billingAccountId: 'billing-1',
      createdAt: '2026-03-11T10:00:00.000Z',
      updatedAt: '2026-03-11T10:00:00.000Z'
    });

    await upsertMembership({
      membershipId: '7e063ff7-3112-426e-8f60-6b9d6414dbe5',
      accountId,
      orgId: '4d69d34a-1ec8-4c60-bf02-7e1fe63fe0ed',
      role: 'owner',
      status: 'active',
      invitedAt: null,
      joinedAt: '2026-03-11T10:01:00.000Z',
      invitedByAccountId: null,
      createdAt: '2026-03-11T10:01:00.000Z',
      updatedAt: '2026-03-11T10:01:00.000Z'
    });

    await upsertDeviceProfile({
      deviceId: '64df6801-ce5f-4832-8b6d-752b6c5f18e9',
      orgId: '4d69d34a-1ec8-4c60-bf02-7e1fe63fe0ed',
      machineName: 'ADMIN-BOX',
      deviceDisplayName: 'Admin Workstation',
      platform: 'windows',
      agentVersion: '1.0.0',
      status: 'active',
      firstSeenAt: '2026-03-11T10:02:00.000Z',
      lastSeenAt: '2026-03-11T10:03:00.000Z',
      currentAccountId: accountId,
      revokedAt: null,
      createdAt: '2026-03-11T10:02:00.000Z',
      updatedAt: '2026-03-11T10:03:00.000Z'
    });

    const orgsResponse = await request(app).get('/v1/me/organizations').set('authorization', `Bearer ${token}`);
    expect(orgsResponse.status).toBe(200);
    expect(orgsResponse.body).toHaveLength(1);
    expect(orgsResponse.body[0]?.organization?.orgName).toBe('PORTA Labs');

    const devicesResponse = await request(app).get('/v1/me/devices').set('authorization', `Bearer ${token}`);
    expect(devicesResponse.status).toBe(200);
    expect(devicesResponse.body).toHaveLength(1);
    expect(devicesResponse.body[0]?.deviceDisplayName).toBe('Admin Workstation');

    const patchResponse = await request(app)
      .patch('/v1/me/profile')
      .set('authorization', `Bearer ${token}`)
      .send({ display_name: 'Admin Prime' });
    expect(patchResponse.status).toBe(200);
    expect(patchResponse.body.account.displayName).toBe('Admin Prime');

    const revokeResponse = await request(app)
      .post('/v1/me/devices/64df6801-ce5f-4832-8b6d-752b6c5f18e9/revoke')
      .set('authorization', `Bearer ${token}`);
    expect(revokeResponse.status).toBe(200);
    expect(revokeResponse.body.device.status).toBe('revoked');
    expect(revokeResponse.body.device.revokedAt).toBeTruthy();

    const postRevokeDevices = await request(app).get('/v1/me/devices').set('authorization', `Bearer ${token}`);
    expect(postRevokeDevices.status).toBe(200);
    expect(postRevokeDevices.body).toHaveLength(1);
    expect(postRevokeDevices.body[0]?.status).toBe('revoked');
  });

  it('distinguishes account legal consent from device capture consent on /v1/me', async () => {
    const token = await loginAdmin();

    const meResponse = await request(app).get('/v1/me').set('authorization', `Bearer ${token}`);
    expect(meResponse.status).toBe(200);
    const accountId = meResponse.body.account.accountId as string;

    await upsertOrganizationProfile({
      orgId: '4d69d34a-1ec8-4c60-bf02-7e1fe63fe0ed',
      orgName: 'PORTA Labs',
      orgSlug: 'porta-labs',
      planTier: 'pro',
      billingAccountId: 'billing-1',
      createdAt: '2026-03-11T10:00:00.000Z',
      updatedAt: '2026-03-11T10:00:00.000Z'
    });

    await upsertMembership({
      membershipId: '7e063ff7-3112-426e-8f60-6b9d6414dbe5',
      accountId,
      orgId: '4d69d34a-1ec8-4c60-bf02-7e1fe63fe0ed',
      role: 'owner',
      status: 'active',
      invitedAt: null,
      joinedAt: '2026-03-11T10:01:00.000Z',
      invitedByAccountId: null,
      createdAt: '2026-03-11T10:01:00.000Z',
      updatedAt: '2026-03-11T10:01:00.000Z'
    });

    await upsertDeviceProfile({
      deviceId: '64df6801-ce5f-4832-8b6d-752b6c5f18e9',
      orgId: '4d69d34a-1ec8-4c60-bf02-7e1fe63fe0ed',
      machineName: 'ADMIN-BOX',
      deviceDisplayName: 'Admin Workstation',
      platform: 'windows',
      agentVersion: '1.0.0',
      status: 'active',
      firstSeenAt: '2026-03-11T10:02:00.000Z',
      lastSeenAt: '2026-03-11T10:03:00.000Z',
      currentAccountId: accountId,
      revokedAt: null,
      createdAt: '2026-03-11T10:02:00.000Z',
      updatedAt: '2026-03-11T10:03:00.000Z'
    });

    await upsertConsentRecord({
      consentId: 'cc28b71e-c01c-44b9-8c06-2d98585d71ea',
      scope: 'device_capture',
      accountId,
      deviceId: '64df6801-ce5f-4832-8b6d-752b6c5f18e9',
      orgId: '4d69d34a-1ec8-4c60-bf02-7e1fe63fe0ed',
      consentVersion: 'v1',
      consentState: 'revoked',
      telemetryLevel: 'essential',
      consentedAt: '2026-03-11T11:08:00.000Z',
      updatedAt: '2026-03-11T11:08:00.000Z'
    });

    const refreshed = await request(app).get('/v1/me').set('authorization', `Bearer ${token}`);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.devices).toHaveLength(1);
    expect(refreshed.body.consents).toHaveLength(2);
    expect(refreshed.body.consents.some((entry: { scope?: string; consentState?: string; deviceId?: string | null; }) =>
      entry.scope === 'account_legal' && entry.consentState === 'accepted' && (entry.deviceId ?? null) === null)).toBe(true);
    expect(refreshed.body.consents.some((entry: { scope?: string; consentState?: string; deviceId?: string | null; }) =>
      entry.scope === 'device_capture' && entry.consentState === 'revoked' && entry.deviceId === '64df6801-ce5f-4832-8b6d-752b6c5f18e9')).toBe(true);
  });

  it('supports explicit unlink for the signed-in account device list', async () => {
    const token = await loginAdmin();

    const meResponse = await request(app).get('/v1/me').set('authorization', `Bearer ${token}`);
    expect(meResponse.status).toBe(200);
    const accountId = meResponse.body.account.accountId as string;

    await upsertDeviceProfile({
      deviceId: '85ae9f8c-ae1f-4bc2-90d7-46f021ff9300',
      orgId: '4d69d34a-1ec8-4c60-bf02-7e1fe63fe0ed',
      machineName: 'ADMIN-BOX',
      deviceDisplayName: 'Admin Workstation',
      platform: 'windows',
      agentVersion: '1.0.0',
      status: 'active',
      firstSeenAt: '2026-03-11T10:02:00.000Z',
      lastSeenAt: '2026-03-11T10:03:00.000Z',
      currentAccountId: accountId,
      revokedAt: null,
      createdAt: '2026-03-11T10:02:00.000Z',
      updatedAt: '2026-03-11T10:03:00.000Z'
    });

    const unlinkResponse = await request(app)
      .post('/v1/me/devices/85ae9f8c-ae1f-4bc2-90d7-46f021ff9300/unlink')
      .set('authorization', `Bearer ${token}`);
    expect(unlinkResponse.status).toBe(200);
    expect(unlinkResponse.body.device.status).toBe('unlinked');
    expect(unlinkResponse.body.device.currentAccountId).toBeNull();
    expect(unlinkResponse.body.device.orgId).toBeNull();

    const devicesResponse = await request(app).get('/v1/me/devices').set('authorization', `Bearer ${token}`);
    expect(devicesResponse.status).toBe(200);
    expect(devicesResponse.body).toHaveLength(0);
  });

  it('materializes the account profile on login before /v1/me is opened', async () => {
    const loginResponse = await request(app).post('/auth/login').send({
      user_id: 'admin',
      password: 'porta-admin'
    });

    expect(loginResponse.status).toBe(200);
    const token = loginResponse.body.access_token as string;
    const accountId = loginResponse.body.user.account_id as string;

    const accountResponse = await request(app)
      .get(`/v1/admin/accounts/${accountId}`)
      .set('authorization', `Bearer ${token}`);
    expect(accountResponse.status).toBe(200);
    expect(accountResponse.body.account.primaryEmail).toBe('admin');
    expect(accountResponse.body.consents).toHaveLength(1);
    expect(accountResponse.body.consents[0]?.scope).toBe('account_legal');
  });

  it('updates lastLoginAt on successful login but not on /v1/me read endpoints', async () => {
    const loginResponse = await request(app).post('/auth/login').send({
      user_id: 'admin',
      password: 'porta-admin'
    });

    expect(loginResponse.status).toBe(200);
    const token = loginResponse.body.access_token as string;
    const accountId = loginResponse.body.user.account_id as string;

    const afterLogin = await getAccountProfile(accountId);
    expect(afterLogin?.lastLoginAt).toBeTruthy();
    const touchedAt = afterLogin?.lastLoginAt ?? null;

    const meResponse = await request(app).get('/v1/me').set('authorization', `Bearer ${token}`);
    expect(meResponse.status).toBe(200);

    const organizationsResponse = await request(app).get('/v1/me/organizations').set('authorization', `Bearer ${token}`);
    expect(organizationsResponse.status).toBe(200);

    const devicesResponse = await request(app).get('/v1/me/devices').set('authorization', `Bearer ${token}`);
    expect(devicesResponse.status).toBe(200);

    const afterReads = await getAccountProfile(accountId);
    expect(afterReads?.lastLoginAt).toBe(touchedAt);
  });

  it('materializes newly registered users into admin account views immediately', async () => {
    const adminToken = await loginAdmin();
    const userId = `new.user+${Date.now()}@example.com`;

    const registerResponse = await request(app).post('/auth/register').send({
      user_id: userId,
      password: 'ValidPass1',
      display_name: 'New User'
    });

    expect(registerResponse.status).toBe(201);
    const accountId = registerResponse.body.user.account_id as string;

    const accountResponse = await request(app)
      .get(`/v1/admin/accounts/${accountId}`)
      .set('authorization', `Bearer ${adminToken}`);
    expect(accountResponse.status).toBe(200);
    expect(accountResponse.body.account.primaryEmail).toBe(userId);
    expect(accountResponse.body.memberships).toHaveLength(1);
    expect(accountResponse.body.memberships[0]?.membership?.status).toBe('active');
    expect(accountResponse.body.memberships[0]?.membership?.role).toBe('owner');
    expect(accountResponse.body.memberships[0]?.organization?.orgName).toContain('Workspace');
    expect(accountResponse.body.consents).toHaveLength(1);
    expect(accountResponse.body.consents[0]?.scope).toBe('account_legal');

    const growthEvents = await listGrowthEventsForAccount(accountId);
    expect(growthEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(['account_registered', 'membership_joined'])
    );
  });

  it('auto-provisions a workspace for self-registered users on /v1/me', async () => {
    const userId = `workspace.user+${Date.now()}@example.com`;

    const registerResponse = await request(app).post('/auth/register').send({
      user_id: userId,
      password: 'ValidPass1',
      display_name: 'Workspace User'
    });

    expect(registerResponse.status).toBe(201);

    const loginResponse = await request(app).post('/auth/login').send({
      user_id: userId,
      password: 'ValidPass1'
    });

    expect(loginResponse.status).toBe(200);
    const token = loginResponse.body.access_token as string;

    const meResponse = await request(app)
      .get('/v1/me')
      .set('authorization', `Bearer ${token}`);
    expect(meResponse.status).toBe(200);
    expect(meResponse.body.organizations).toHaveLength(1);
    expect(meResponse.body.organizations[0]?.membership?.status).toBe('active');
    expect(meResponse.body.organizations[0]?.membership?.role).toBe('owner');
    expect(meResponse.body.organizations[0]?.organization?.orgName).toBe('Workspace User Workspace');
  });

  it('serves admin account and organization views from identity stores', async () => {
    const token = await loginAdmin();
    const meResponse = await request(app).get('/v1/me').set('authorization', `Bearer ${token}`);
    expect(meResponse.status).toBe(200);
    const accountId = meResponse.body.account.accountId as string;

    await upsertOrganizationProfile({
      orgId: '338dc68c-0a6f-4d77-ac89-7ba6c3736fec',
      orgName: 'PORTA Ops',
      orgSlug: 'porta-ops',
      planTier: 'enterprise',
      billingAccountId: 'billing-ops',
      createdAt: '2026-03-11T11:00:00.000Z',
      updatedAt: '2026-03-11T11:00:00.000Z'
    });

    await upsertMembership({
      membershipId: '468fd688-c4d0-46b2-9b6d-1adfcf77ce95',
      accountId,
      orgId: '338dc68c-0a6f-4d77-ac89-7ba6c3736fec',
      role: 'owner',
      status: 'active',
      invitedAt: null,
      joinedAt: '2026-03-11T11:05:00.000Z',
      invitedByAccountId: null,
      createdAt: '2026-03-11T11:05:00.000Z',
      updatedAt: '2026-03-11T11:05:00.000Z'
    });

    await upsertDeviceProfile({
      deviceId: '1f3074fa-d7b1-4add-8fc0-86d4e4b31c14',
      orgId: '338dc68c-0a6f-4d77-ac89-7ba6c3736fec',
      machineName: 'OPS-BOX',
      deviceDisplayName: 'Ops Desktop',
      platform: 'windows',
      agentVersion: '1.0.0',
      status: 'active',
      firstSeenAt: '2026-03-11T11:06:00.000Z',
      lastSeenAt: '2026-03-11T11:07:00.000Z',
      currentAccountId: accountId,
      revokedAt: null,
      createdAt: '2026-03-11T11:06:00.000Z',
      updatedAt: '2026-03-11T11:07:00.000Z'
    });

    await upsertConsentRecord({
      consentId: 'cc28b71e-c01c-44b9-8c06-2d98585d71ea',
      scope: 'device_capture',
      accountId,
      deviceId: '1f3074fa-d7b1-4add-8fc0-86d4e4b31c14',
      orgId: '338dc68c-0a6f-4d77-ac89-7ba6c3736fec',
      consentVersion: 'v1',
      consentState: 'accepted',
      telemetryLevel: 'enhanced',
      consentedAt: '2026-03-11T11:08:00.000Z',
      updatedAt: '2026-03-11T11:08:00.000Z'
    });

    const accountResponse = await request(app)
      .get(`/v1/admin/accounts/${accountId}`)
      .set('authorization', `Bearer ${token}`);
    expect(accountResponse.status).toBe(200);
    expect(accountResponse.body.account.accountId).toBe(accountId);
    expect(accountResponse.body.memberships).toHaveLength(1);
    expect(accountResponse.body.devices).toHaveLength(1);
    expect(accountResponse.body.consents).toHaveLength(2);

    const orgResponse = await request(app)
      .get('/v1/admin/organizations/338dc68c-0a6f-4d77-ac89-7ba6c3736fec')
      .set('authorization', `Bearer ${token}`);
    expect(orgResponse.status).toBe(200);
    expect(orgResponse.body.organization.orgName).toBe('PORTA Ops');
    expect(orgResponse.body.memberships).toHaveLength(1);
    expect(orgResponse.body.devices).toHaveLength(1);
    expect(orgResponse.body.consents).toHaveLength(1);
  });

  it('supports admin device listing, revoke, and unlink for an account', async () => {
    const token = await loginAdmin();
    const meResponse = await request(app).get('/v1/me').set('authorization', `Bearer ${token}`);
    expect(meResponse.status).toBe(200);
    const accountId = meResponse.body.account.accountId as string;

    await upsertDeviceProfile({
      deviceId: '1f3074fa-d7b1-4add-8fc0-86d4e4b31c14',
      orgId: '338dc68c-0a6f-4d77-ac89-7ba6c3736fec',
      machineName: 'OPS-BOX',
      deviceDisplayName: 'Ops Desktop',
      platform: 'windows',
      agentVersion: '1.0.0',
      status: 'active',
      firstSeenAt: '2026-03-11T11:06:00.000Z',
      lastSeenAt: '2026-03-11T11:07:00.000Z',
      currentAccountId: accountId,
      revokedAt: null,
      createdAt: '2026-03-11T11:06:00.000Z',
      updatedAt: '2026-03-11T11:07:00.000Z'
    });

    const listResponse = await request(app)
      .get(`/v1/admin/accounts/${accountId}/devices`)
      .set('authorization', `Bearer ${token}`);
    expect(listResponse.status).toBe(200);
    expect(listResponse.body).toHaveLength(1);
    expect(listResponse.body[0]?.status).toBe('active');

    const revokeResponse = await request(app)
      .post(`/v1/admin/accounts/${accountId}/devices/1f3074fa-d7b1-4add-8fc0-86d4e4b31c14/revoke`)
      .set('authorization', `Bearer ${token}`);
    expect(revokeResponse.status).toBe(200);
    expect(revokeResponse.body.device.status).toBe('revoked');
    expect(revokeResponse.body.device.currentAccountId).toBe(accountId);

    const afterRevoke = await request(app)
      .get(`/v1/admin/accounts/${accountId}/devices`)
      .set('authorization', `Bearer ${token}`);
    expect(afterRevoke.status).toBe(200);
    expect(afterRevoke.body).toHaveLength(1);
    expect(afterRevoke.body[0]?.status).toBe('revoked');

    const unlinkResponse = await request(app)
      .post(`/v1/admin/accounts/${accountId}/devices/1f3074fa-d7b1-4add-8fc0-86d4e4b31c14/unlink`)
      .set('authorization', `Bearer ${token}`);
    expect(unlinkResponse.status).toBe(200);
    expect(unlinkResponse.body.device.status).toBe('unlinked');
    expect(unlinkResponse.body.device.currentAccountId).toBeNull();
    expect(unlinkResponse.body.device.orgId).toBeNull();

    const afterUnlink = await request(app)
      .get(`/v1/admin/accounts/${accountId}/devices`)
      .set('authorization', `Bearer ${token}`);
    expect(afterUnlink.status).toBe(200);
    expect(afterUnlink.body).toHaveLength(0);
  });
});
