import * as fs from 'node:fs';
import * as path from 'node:path';
import * as supertest from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetSLOGateStateForTests } from '../src/core/sloEvaluator.js';
import { clearGrowthEventStoreForTests } from '../src/store/growthEventStore.js';
import { loadRuntimeState, resetRuntimeStateForTests } from '../src/store/runtimeState.js';
import { clearAccountStoreForTests, upsertAccountProfile } from '../src/store/accountStore.js';
import { clearAccountActiveDayStoreForTests } from '../src/store/accountActiveDayStore.js';
import { clearOrganizationStoreForTests, upsertOrganizationProfile } from '../src/store/organizationStore.js';
import { clearMembershipStoreForTests, upsertMembership } from '../src/store/membershipStore.js';
import { clearDeviceStoreForTests, upsertDeviceProfile } from '../src/store/deviceStore.js';
import { clearConsentRecordStoreForTests } from '../src/store/consentRecordStore.js';
import { clearAuthSessionStoreForTests } from '../src/core/authSessionStore.js';
import {
  clearDeviceCredentialStoreForTests,
  deviceSecretMatches,
  getDeviceCredential,
  listDeviceCredentialIssuances
} from '../src/store/deviceCredentialStore.js';

const dataDir = path.resolve('.data');
const request = (supertest as unknown as { default: typeof supertest }).default as unknown as typeof import('supertest');
const app = createApp();

const accountId = '2094e8ad-74f6-45fc-a044-c9ab6f9f0a4b';
const orgId = '6b7fd26e-ae90-4d4c-9d8e-e95c15db89e1';
const deviceId = 'd93d90c1-a120-4c72-89ee-5c7d16efea31';

function registerBody(overrides: Record<string, unknown> = {}) {
  return {
    deviceId,
    machineName: 'ALICE-BOX',
    deviceDisplayName: 'ALICE-BOX',
    platform: 'windows',
    agentVersion: '1.2.124',
    ...overrides
  };
}

async function seedLinkedDevice(status: string = 'active'): Promise<void> {
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

  await upsertDeviceProfile({
    deviceId,
    orgId,
    machineName: 'ALICE-BOX',
    deviceDisplayName: 'ALICE-BOX',
    platform: 'windows',
    agentVersion: '1.2.123',
    status,
    firstSeenAt: '2026-03-11T12:00:00.000Z',
    lastSeenAt: '2026-07-31T12:00:00.000Z',
    currentAccountId: accountId,
    revokedAt: null,
    createdAt: '2026-03-11T12:00:00.000Z',
    updatedAt: '2026-07-31T12:00:00.000Z'
  });
}

describe('credential bootstrap on register', () => {
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
    clearDeviceCredentialStoreForTests();
    loadRuntimeState();
  });

  // The whole point: a linked machine acquires its credential with nobody present.
  it('issues a credential to a linked device that has none', async () => {
    await seedLinkedDevice();

    const response = await request(app).post('/api/device/register').send(registerBody());

    expect(response.status).toBe(200);
    expect(typeof response.body.deviceSecret).toBe('string');
    expect(response.body.deviceSecret.length).toBeGreaterThan(20);

    const stored = await getDeviceCredential(deviceId);
    expect(stored).not.toBeNull();
    expect(deviceSecretMatches(response.body.deviceSecret, stored!.secretHash)).toBe(true);
  });

  it('issues once — a second register returns no secret and does not rotate', async () => {
    await seedLinkedDevice();

    const first = await request(app).post('/api/device/register').send(registerBody());
    const firstStored = await getDeviceCredential(deviceId);

    const second = await request(app).post('/api/device/register').send(registerBody());

    expect(first.body.deviceSecret).toBeDefined();
    expect(second.body.deviceSecret).toBeUndefined();

    const secondStored = await getDeviceCredential(deviceId);
    expect(secondStored!.secretHash).toBe(firstStored!.secretHash);
    expect(deviceSecretMatches(first.body.deviceSecret, secondStored!.secretHash)).toBe(true);
  });

  it('issues nothing to an unlinked device', async () => {
    const response = await request(app).post('/api/device/register').send(registerBody());

    expect(response.status).toBe(200);
    expect(response.body.deviceSecret).toBeUndefined();
    expect(await getDeviceCredential(deviceId)).toBeNull();
  });

  it('issues nothing to a revoked device', async () => {
    await seedLinkedDevice('revoked');

    const response = await request(app).post('/api/device/register').send(registerBody());

    expect(response.body.deviceSecret).toBeUndefined();
    expect(await getDeviceCredential(deviceId)).toBeNull();
  });

  describe('agent capability gate', () => {
    // The live incident this exists for: agents register at boot, so without this gate every
    // reboot of an older build consumed its one issuance and stranded the machine permanently.
    it('issues nothing to an agent too old to store it', async () => {
      await seedLinkedDevice();

      const response = await request(app)
        .post('/api/device/register')
        .send(registerBody({ agentVersion: '1.2.123' }));

      expect(response.status).toBe(200);
      expect(response.body.deviceSecret).toBeUndefined();
      expect(await getDeviceCredential(deviceId)).toBeNull();
      expect(await listDeviceCredentialIssuances(deviceId)).toHaveLength(0);
    });

    it('issues nothing for the four-part version older builds report', async () => {
      await seedLinkedDevice();

      const response = await request(app)
        .post('/api/device/register')
        .send(registerBody({ agentVersion: '1.2.123.0' }));

      expect(response.body.deviceSecret).toBeUndefined();
      expect(await getDeviceCredential(deviceId)).toBeNull();
    });

    it('issues to 1.2.124 and later', async () => {
      await seedLinkedDevice();

      const response = await request(app)
        .post('/api/device/register')
        .send(registerBody({ agentVersion: '1.2.124.0' }));

      expect(typeof response.body.deviceSecret).toBe('string');
    });

    it('issues on the explicit capability flag even without a qualifying version', async () => {
      await seedLinkedDevice();

      const response = await request(app)
        .post('/api/device/register')
        .send(registerBody({ agentVersion: '1.2.123', supportsCredentialStorage: true }));

      expect(typeof response.body.deviceSecret).toBe('string');
    });

    it('issues nothing for an unparseable version', async () => {
      await seedLinkedDevice();

      const response = await request(app)
        .post('/api/device/register')
        .send(registerBody({ agentVersion: 'unknown' }));

      expect(response.body.deviceSecret).toBeUndefined();
      expect(await getDeviceCredential(deviceId)).toBeNull();
    });
  });

  describe('issuance log', () => {
    it('records the bootstrap issuance durably', async () => {
      await seedLinkedDevice();
      await request(app).post('/api/device/register').send(registerBody());

      const log = await listDeviceCredentialIssuances(deviceId);
      expect(log).toHaveLength(1);
      expect(log[0]?.source).toBe('register-bootstrap');
      expect(log[0]?.accountId).toBe(accountId);
      expect(log[0]?.replacedExisting).toBe(false);
      expect(log[0]?.issuedAtUtc).toBeTruthy();
    });

    it('logs nothing when no credential was issued', async () => {
      await seedLinkedDevice();
      await request(app).post('/api/device/register').send(registerBody());
      await request(app).post('/api/device/register').send(registerBody());

      // Two registers, one issuance — the second was a no-op and must not appear.
      expect(await listDeviceCredentialIssuances(deviceId)).toHaveLength(1);
    });

    // The log must never contain the secret itself, or it becomes the thing it audits.
    it('never stores the plaintext secret', async () => {
      await seedLinkedDevice();
      const response = await request(app).post('/api/device/register').send(registerBody());

      const serialised = JSON.stringify(await listDeviceCredentialIssuances(deviceId));
      expect(serialised).not.toContain(response.body.deviceSecret);
    });
  });
});
