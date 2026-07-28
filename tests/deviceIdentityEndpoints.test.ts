import * as fs from 'node:fs';
import * as path from 'node:path';
import * as supertest from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetSLOGateStateForTests } from '../src/core/sloEvaluator.js';
import { clearGrowthEventStoreForTests, listGrowthEventsForAccount } from '../src/store/growthEventStore.js';
import { loadRuntimeState, resetRuntimeStateForTests } from '../src/store/runtimeState.js';
import { clearAccountStoreForTests, upsertAccountProfile } from '../src/store/accountStore.js';
import { clearAccountActiveDayStoreForTests } from '../src/store/accountActiveDayStore.js';
import { clearOrganizationStoreForTests, upsertOrganizationProfile } from '../src/store/organizationStore.js';
import { clearMembershipStoreForTests, upsertMembership } from '../src/store/membershipStore.js';
import { clearDeviceStoreForTests } from '../src/store/deviceStore.js';
import { clearConsentRecordStoreForTests, listConsentRecordsForDevice } from '../src/store/consentRecordStore.js';
import { clearAuthSessionStoreForTests, issueAuthSession } from '../src/core/authSessionStore.js';

const dataDir = path.resolve('.data');
const request = (supertest as unknown as { default: typeof supertest }).default as unknown as typeof import('supertest');
const app = createApp();

// Mints a session directly rather than signing in, so the suite does not depend on
// the dev-only default logins or on a shared process.env flag. The tests run
// single-threaded in one process (see the --pool=threads npm script), so any env
// toggling here would leak into every other suite.
async function sessionTokenFor(accountId: string, userId = 'alice@example.com'): Promise<string> {
  const issued = await issueAuthSession({
    account_id: accountId,
    user_id: userId,
    role: 'developer',
    base_role: 'developer',
    display_name: 'Alice',
    auth_provider: 'local',
    source: 'custom'
  });

  return issued.access_token;
}

describe('device identity endpoints', () => {
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
    clearAuthSessionStoreForTests();
    loadRuntimeState();
  });

  it('registers an unlinked device before any account link exists', async () => {
    const response = await request(app).post('/api/device/register').send({
      deviceId: '6f390ec2-31b7-4f49-9c11-e508d477b633',
      machineName: 'HP-LAPTOP',
      platform: 'windows',
      agentVersion: '1.0.0'
    });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.linkState).toBe('unlinked');
    expect(response.body.device.deviceId).toBe('6f390ec2-31b7-4f49-9c11-e508d477b633');
    expect(response.body.device.currentAccountId).toBeNull();
  });

  it('links and unlinks a registered device explicitly', async () => {
    await upsertAccountProfile({
      accountId: '2094e8ad-74f6-45fc-a044-c9ab6f9f0a4b',
      displayName: 'Alice',
      primaryEmail: 'alice@example.com',
      emailVerified: true,
      avatarUrl: null,
      status: 'active',
      authProvider: 'local',
      lastLoginAt: null,
      createdAt: '2026-03-11T12:00:00.000Z',
      updatedAt: '2026-03-11T12:00:00.000Z'
    });

    await upsertOrganizationProfile({
      orgId: '6b7fd26e-ae90-4d4c-9d8e-e95c15db89e1',
      orgName: 'PORTA Labs',
      orgSlug: 'porta-labs',
      planTier: 'pro',
      billingAccountId: 'billing-1',
      createdAt: '2026-03-11T12:00:00.000Z',
      updatedAt: '2026-03-11T12:00:00.000Z'
    });

    await upsertMembership({
      membershipId: 'f86b5272-1f29-4a52-a7af-8382d800d448',
      accountId: '2094e8ad-74f6-45fc-a044-c9ab6f9f0a4b',
      orgId: '6b7fd26e-ae90-4d4c-9d8e-e95c15db89e1',
      role: 'member',
      status: 'active',
      invitedAt: null,
      joinedAt: '2026-03-11T12:01:00.000Z',
      invitedByAccountId: null,
      createdAt: '2026-03-11T12:01:00.000Z',
      updatedAt: '2026-03-11T12:01:00.000Z'
    });

    const registerResponse = await request(app).post('/api/device/register').send({
      deviceId: 'd93d90c1-a120-4c72-89ee-5c7d16efea31',
      machineName: 'ALICE-BOX',
      deviceDisplayName: 'Alice Workstation',
      platform: 'windows',
      agentVersion: '1.0.0'
    });

    expect(registerResponse.status).toBe(200);
    expect(registerResponse.body.linkState).toBe('unlinked');

    const token = await sessionTokenFor('2094e8ad-74f6-45fc-a044-c9ab6f9f0a4b');

    const linkResponse = await request(app)
      .post('/api/device/link-account')
      .set('authorization', `Bearer ${token}`)
      .send({
        deviceId: 'd93d90c1-a120-4c72-89ee-5c7d16efea31',
        accountId: '2094e8ad-74f6-45fc-a044-c9ab6f9f0a4b',
        orgId: '6b7fd26e-ae90-4d4c-9d8e-e95c15db89e1'
      });

    expect(linkResponse.status).toBe(200);
    expect(linkResponse.body.linkState).toBe('linked');
    expect(linkResponse.body.device.currentAccountId).toBe('2094e8ad-74f6-45fc-a044-c9ab6f9f0a4b');
    expect(linkResponse.body.device.orgId).toBe('6b7fd26e-ae90-4d4c-9d8e-e95c15db89e1');

    const unlinkResponse = await request(app)
      .post('/api/device/unlink-account')
      .set('authorization', `Bearer ${token}`)
      .send({
        deviceId: 'd93d90c1-a120-4c72-89ee-5c7d16efea31',
        accountId: '2094e8ad-74f6-45fc-a044-c9ab6f9f0a4b',
        orgId: '6b7fd26e-ae90-4d4c-9d8e-e95c15db89e1'
      });

    expect(unlinkResponse.status).toBe(200);
    expect(unlinkResponse.body.linkState).toBe('unlinked');
    expect(unlinkResponse.body.device.status).toBe('unlinked');
    expect(unlinkResponse.body.device.currentAccountId).toBeNull();
    expect(unlinkResponse.body.device.orgId).toBeNull();
  });

  it('does not relink a device implicitly during inventory registration', async () => {
    await upsertAccountProfile({
      accountId: '2094e8ad-74f6-45fc-a044-c9ab6f9f0a4b',
      displayName: 'Alice',
      primaryEmail: 'alice@example.com',
      emailVerified: true,
      avatarUrl: null,
      status: 'active',
      authProvider: 'local',
      lastLoginAt: null,
      createdAt: '2026-03-11T12:00:00.000Z',
      updatedAt: '2026-03-11T12:00:00.000Z'
    });

    await upsertOrganizationProfile({
      orgId: '6b7fd26e-ae90-4d4c-9d8e-e95c15db89e1',
      orgName: 'PORTA Labs',
      orgSlug: 'porta-labs',
      planTier: 'pro',
      billingAccountId: 'billing-1',
      createdAt: '2026-03-11T12:00:00.000Z',
      updatedAt: '2026-03-11T12:00:00.000Z'
    });

    await upsertMembership({
      membershipId: 'f86b5272-1f29-4a52-a7af-8382d800d448',
      accountId: '2094e8ad-74f6-45fc-a044-c9ab6f9f0a4b',
      orgId: '6b7fd26e-ae90-4d4c-9d8e-e95c15db89e1',
      role: 'member',
      status: 'active',
      invitedAt: null,
      joinedAt: '2026-03-11T12:01:00.000Z',
      invitedByAccountId: null,
      createdAt: '2026-03-11T12:01:00.000Z',
      updatedAt: '2026-03-11T12:01:00.000Z'
    });

    const registerResponse = await request(app).post('/api/device/register').send({
      deviceId: 'f58fc1f8-a478-4302-9702-6d774936748d',
      machineName: 'ALICE-LAPTOP',
      deviceDisplayName: 'Alice Laptop',
      platform: 'windows',
      agentVersion: '1.0.0'
    });

    expect(registerResponse.status).toBe(200);
    expect(registerResponse.body.linkState).toBe('unlinked');

    const relinkAttempt = await request(app).post('/api/device/register').send({
      deviceId: 'f58fc1f8-a478-4302-9702-6d774936748d',
      machineName: 'ALICE-LAPTOP',
      deviceDisplayName: 'Alice Laptop',
      platform: 'windows',
      agentVersion: '1.0.1',
      accountId: '2094e8ad-74f6-45fc-a044-c9ab6f9f0a4b',
      orgId: '6b7fd26e-ae90-4d4c-9d8e-e95c15db89e1'
    });

    expect(relinkAttempt.status).toBe(200);
    expect(relinkAttempt.body.linkState).toBe('unlinked');
    expect(relinkAttempt.body.device.status).toBe('active');
    expect(relinkAttempt.body.device.currentAccountId).toBeNull();
    expect(relinkAttempt.body.device.orgId).toBeNull();
    expect(await listConsentRecordsForDevice('f58fc1f8-a478-4302-9702-6d774936748d')).toHaveLength(0);
  });

  it('syncs device capture consent only for an already linked device', async () => {
    await upsertAccountProfile({
      accountId: '2094e8ad-74f6-45fc-a044-c9ab6f9f0a4b',
      displayName: 'Alice',
      primaryEmail: 'alice@example.com',
      emailVerified: true,
      avatarUrl: null,
      status: 'active',
      authProvider: 'local',
      lastLoginAt: null,
      createdAt: '2026-03-11T12:00:00.000Z',
      updatedAt: '2026-03-11T12:00:00.000Z'
    });

    await upsertOrganizationProfile({
      orgId: '6b7fd26e-ae90-4d4c-9d8e-e95c15db89e1',
      orgName: 'PORTA Labs',
      orgSlug: 'porta-labs',
      planTier: 'pro',
      billingAccountId: 'billing-1',
      createdAt: '2026-03-11T12:00:00.000Z',
      updatedAt: '2026-03-11T12:00:00.000Z'
    });

    await upsertMembership({
      membershipId: 'f86b5272-1f29-4a52-a7af-8382d800d448',
      accountId: '2094e8ad-74f6-45fc-a044-c9ab6f9f0a4b',
      orgId: '6b7fd26e-ae90-4d4c-9d8e-e95c15db89e1',
      role: 'member',
      status: 'active',
      invitedAt: null,
      joinedAt: '2026-03-11T12:01:00.000Z',
      invitedByAccountId: null,
      createdAt: '2026-03-11T12:01:00.000Z',
      updatedAt: '2026-03-11T12:01:00.000Z'
    });

    await request(app).post('/api/device/register').send({
      deviceId: 'd93d90c1-a120-4c72-89ee-5c7d16efea31',
      machineName: 'ALICE-BOX',
      deviceDisplayName: 'Alice Workstation',
      platform: 'windows',
      agentVersion: '1.0.0'
    });

    const linkResponse = await request(app)
      .post('/api/device/link-account')
      .set('authorization', `Bearer ${await sessionTokenFor('2094e8ad-74f6-45fc-a044-c9ab6f9f0a4b')}`)
      .send({
        deviceId: 'd93d90c1-a120-4c72-89ee-5c7d16efea31',
        accountId: '2094e8ad-74f6-45fc-a044-c9ab6f9f0a4b',
        orgId: '6b7fd26e-ae90-4d4c-9d8e-e95c15db89e1'
      });
    expect(linkResponse.status).toBe(200);

    const registerResponse = await request(app).post('/api/device/register').send({
      deviceId: 'd93d90c1-a120-4c72-89ee-5c7d16efea31',
      machineName: 'ALICE-BOX',
      deviceDisplayName: 'Alice Workstation',
      platform: 'windows',
      agentVersion: '1.0.1',
      accountId: '2094e8ad-74f6-45fc-a044-c9ab6f9f0a4b',
      orgId: '6b7fd26e-ae90-4d4c-9d8e-e95c15db89e1',
      deviceCaptureConsentState: 'revoked',
      deviceCaptureConsentVersion: '1.0.0',
      deviceCaptureConsentedAt: '2026-03-11T12:05:00.000Z',
      deviceCaptureTelemetryLevel: 'essential'
    });

    expect(registerResponse.status).toBe(200);
    expect(registerResponse.body.linkState).toBe('linked');

    const consentRecords = await listConsentRecordsForDevice('d93d90c1-a120-4c72-89ee-5c7d16efea31');
    expect(consentRecords).toHaveLength(1);
    expect(consentRecords[0]?.scope).toBe('device_capture');
    expect(consentRecords[0]?.consentState).toBe('revoked');
    expect(consentRecords[0]?.accountId).toBe('2094e8ad-74f6-45fc-a044-c9ab6f9f0a4b');
    expect(consentRecords[0]?.orgId).toBe('6b7fd26e-ae90-4d4c-9d8e-e95c15db89e1');
  });

  it('records device link and accepted capture consent as growth events', async () => {
    const accountId = '2094e8ad-74f6-45fc-a044-c9ab6f9f0a4b';
    const orgId = '6b7fd26e-ae90-4d4c-9d8e-e95c15db89e1';
    const deviceId = 'd93d90c1-a120-4c72-89ee-5c7d16efea31';

    await upsertAccountProfile({
      accountId,
      displayName: 'Alice',
      primaryEmail: 'alice@example.com',
      emailVerified: true,
      avatarUrl: null,
      status: 'active',
      authProvider: 'local',
      lastLoginAt: null,
      createdAt: '2026-03-11T12:00:00.000Z',
      updatedAt: '2026-03-11T12:00:00.000Z'
    });

    await upsertOrganizationProfile({
      orgId,
      orgName: 'PORTA Labs',
      orgSlug: 'porta-labs',
      planTier: 'pro',
      billingAccountId: 'billing-1',
      createdAt: '2026-03-11T12:00:00.000Z',
      updatedAt: '2026-03-11T12:00:00.000Z'
    });

    await upsertMembership({
      membershipId: 'f86b5272-1f29-4a52-a7af-8382d800d448',
      accountId,
      orgId,
      role: 'member',
      status: 'active',
      invitedAt: null,
      joinedAt: '2026-03-11T12:01:00.000Z',
      invitedByAccountId: null,
      createdAt: '2026-03-11T12:01:00.000Z',
      updatedAt: '2026-03-11T12:01:00.000Z'
    });

    const registerResponse = await request(app).post('/api/device/register').send({
      deviceId,
      machineName: 'ALICE-BOX',
      deviceDisplayName: 'Alice Workstation',
      platform: 'windows',
      agentVersion: '1.0.0'
    });
    expect(registerResponse.status).toBe(200);

    const linkResponse = await request(app)
      .post('/api/device/link-account')
      .set('authorization', `Bearer ${await sessionTokenFor(accountId)}`)
      .send({
        deviceId,
        accountId,
        orgId
      });
    expect(linkResponse.status).toBe(200);

    const consentResponse = await request(app).post('/api/device/register').send({
      deviceId,
      machineName: 'ALICE-BOX',
      deviceDisplayName: 'Alice Workstation',
      platform: 'windows',
      agentVersion: '1.0.1',
      accountId,
      orgId,
      deviceCaptureConsentState: 'accepted',
      deviceCaptureConsentVersion: '1.0.0',
      deviceCaptureConsentedAt: '2026-03-11T12:05:00.000Z',
      deviceCaptureTelemetryLevel: 'enhanced'
    });
    expect(consentResponse.status).toBe(200);

    const growthEvents = await listGrowthEventsForAccount(accountId);
    expect(growthEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(['device_linked', 'device_capture_consented'])
    );
  });

  describe('link and unlink require the signed-in account', () => {
    const accountA = '2094e8ad-74f6-45fc-a044-c9ab6f9f0a4b';
    const accountB = '9d1c0a77-3d31-4f4e-9a5e-4c2b0c3f1f77';
    const orgId = '6b7fd26e-ae90-4d4c-9d8e-e95c15db89e1';
    const deviceId = 'd93d90c1-a120-4c72-89ee-5c7d16efea31';

    async function seedAccount(accountId: string, membershipId: string, displayName: string): Promise<void> {
      await upsertAccountProfile({
        accountId,
        displayName,
        primaryEmail: `${displayName.toLowerCase()}@example.com`,
        emailVerified: true,
        avatarUrl: null,
        status: 'active',
        authProvider: 'local',
        lastLoginAt: null,
        createdAt: '2026-03-11T12:00:00.000Z',
        updatedAt: '2026-03-11T12:00:00.000Z'
      });

      await upsertMembership({
        membershipId,
        accountId,
        orgId,
        role: 'member',
        status: 'active',
        invitedAt: null,
        joinedAt: '2026-03-11T12:01:00.000Z',
        invitedByAccountId: null,
        createdAt: '2026-03-11T12:01:00.000Z',
        updatedAt: '2026-03-11T12:01:00.000Z'
      });
    }

    async function seedOrganization(): Promise<void> {
      await upsertOrganizationProfile({
        orgId,
        orgName: 'PORTA Labs',
        orgSlug: 'porta-labs',
        planTier: 'pro',
        billingAccountId: 'billing-1',
        createdAt: '2026-03-11T12:00:00.000Z',
        updatedAt: '2026-03-11T12:00:00.000Z'
      });
    }

    async function registerDevice(id: string): Promise<void> {
      const response = await request(app).post('/api/device/register').send({
        deviceId: id,
        machineName: 'ALICE-BOX',
        platform: 'windows',
        agentVersion: '1.0.0'
      });
      expect(response.status).toBe(200);
    }

    it('rejects an unauthenticated link', async () => {
      const response = await request(app).post('/api/device/link-account').send({
        deviceId,
        accountId: accountA,
        orgId
      });

      expect(response.status).toBe(401);
      expect(response.body.error_code).toBe('SESSION_REQUIRED');
    });

    it('rejects an unauthenticated unlink', async () => {
      const response = await request(app).post('/api/device/unlink-account').send({
        deviceId,
        accountId: accountA,
        orgId
      });

      expect(response.status).toBe(401);
      expect(response.body.error_code).toBe('SESSION_REQUIRED');
    });

    it('rejects an expired or unknown session token', async () => {
      const response = await request(app)
        .post('/api/device/link-account')
        .set('authorization', 'Bearer not-a-real-token')
        .send({ deviceId, accountId: accountA, orgId });

      expect(response.status).toBe(401);
      expect(response.body.error_code).toBe('SESSION_EXPIRED');
    });

    it('rejects linking a device to an account the session does not own', async () => {
      const response = await request(app)
        .post('/api/device/link-account')
        .set('authorization', `Bearer ${await sessionTokenFor(accountA)}`)
        .send({ deviceId, accountId: accountB, orgId });

      expect(response.status).toBe(403);
      expect(response.body.error_code).toBe('ACCOUNT_MISMATCH');
    });

    it('rejects unlinking a device from an account the session does not own', async () => {
      const response = await request(app)
        .post('/api/device/unlink-account')
        .set('authorization', `Bearer ${await sessionTokenFor(accountA)}`)
        .send({ deviceId, accountId: accountB, orgId });

      expect(response.status).toBe(403);
      expect(response.body.error_code).toBe('ACCOUNT_MISMATCH');
    });

    // The interesting one: accountId is optional on the wire, and the service skips
    // its ownership check when it is null. Omitting it must not become a way to
    // unlink somebody else's device by guessing a device id.
    it('does not let an omitted accountId unlink another account\'s device', async () => {
      await seedOrganization();
      await seedAccount(accountB, 'f86b5272-1f29-4a52-a7af-8382d800d448', 'Bob');
      await registerDevice(deviceId);

      const link = await request(app)
        .post('/api/device/link-account')
        .set('authorization', `Bearer ${await sessionTokenFor(accountB, 'bob@example.com')}`)
        .send({ deviceId, accountId: accountB, orgId });
      expect(link.status).toBe(200);
      expect(link.body.device.currentAccountId).toBe(accountB);

      const attempt = await request(app)
        .post('/api/device/unlink-account')
        .set('authorization', `Bearer ${await sessionTokenFor(accountA)}`)
        .send({ deviceId });

      expect(attempt.status).toBe(409);
      expect(attempt.body.error_code).toBe('DEVICE_LINK_MISMATCH');

      const relink = await request(app)
        .post('/api/device/link-account')
        .set('authorization', `Bearer ${await sessionTokenFor(accountB, 'bob@example.com')}`)
        .send({ deviceId, accountId: accountB, orgId });
      expect(relink.body.device.currentAccountId).toBe(accountB);
    });

    it('ignores the shared operator key on these routes', async () => {
      const previous = process.env.PORTA_OPERATOR_KEY;
      process.env.PORTA_OPERATOR_KEY = 'shared-console-key';
      try {
        const response = await request(app)
          .post('/api/device/link-account')
          .set('x-operator-id', 'console')
          .set('x-operator-role', 'admin')
          .set('x-operator-key', 'shared-console-key')
          .send({ deviceId, accountId: accountA, orgId });

        expect(response.status).toBe(401);
        expect(response.body.error_code).toBe('SESSION_REQUIRED');
      } finally {
        if (previous === undefined) {
          delete process.env.PORTA_OPERATOR_KEY;
        } else {
          process.env.PORTA_OPERATOR_KEY = previous;
        }
      }
    });
  });
});
