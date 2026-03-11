import * as fs from 'node:fs';
import * as path from 'node:path';
import * as supertest from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetSLOGateStateForTests } from '../src/core/sloEvaluator.js';
import { loadRuntimeState, resetRuntimeStateForTests } from '../src/store/runtimeState.js';
import { clearAccountStoreForTests, upsertAccountProfile } from '../src/store/accountStore.js';
import { clearOrganizationStoreForTests, upsertOrganizationProfile } from '../src/store/organizationStore.js';
import { clearMembershipStoreForTests, upsertMembership } from '../src/store/membershipStore.js';
import { clearDeviceStoreForTests } from '../src/store/deviceStore.js';
import { clearConsentRecordStoreForTests } from '../src/store/consentRecordStore.js';

const dataDir = path.resolve('.data');
const request = (supertest as unknown as { default: typeof supertest }).default as unknown as typeof import('supertest');
const app = createApp();

describe('device identity endpoints', () => {
  beforeEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    resetRuntimeStateForTests();
    resetSLOGateStateForTests();
    clearAccountStoreForTests();
    clearOrganizationStoreForTests();
    clearMembershipStoreForTests();
    clearDeviceStoreForTests();
    clearConsentRecordStoreForTests();
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

    const linkResponse = await request(app).post('/api/device/link-account').send({
      deviceId: 'd93d90c1-a120-4c72-89ee-5c7d16efea31',
      accountId: '2094e8ad-74f6-45fc-a044-c9ab6f9f0a4b',
      orgId: '6b7fd26e-ae90-4d4c-9d8e-e95c15db89e1'
    });

    expect(linkResponse.status).toBe(200);
    expect(linkResponse.body.linkState).toBe('linked');
    expect(linkResponse.body.device.currentAccountId).toBe('2094e8ad-74f6-45fc-a044-c9ab6f9f0a4b');
    expect(linkResponse.body.device.orgId).toBe('6b7fd26e-ae90-4d4c-9d8e-e95c15db89e1');

    const unlinkResponse = await request(app).post('/api/device/unlink-account').send({
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
  });
});
