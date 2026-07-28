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
import { clearDeviceStoreForTests } from '../src/store/deviceStore.js';
import { clearConsentRecordStoreForTests } from '../src/store/consentRecordStore.js';
import { clearAuthSessionStoreForTests, issueAuthSession } from '../src/core/authSessionStore.js';
import {
  clearDeviceCredentialStoreForTests,
  deviceSecretMatches,
  generateDeviceSecret,
  getDeviceCredential,
  hashDeviceSecret
} from '../src/store/deviceCredentialStore.js';

const dataDir = path.resolve('.data');
const request = (supertest as unknown as { default: typeof supertest }).default as unknown as typeof import('supertest');
const app = createApp();

const accountA = '2094e8ad-74f6-45fc-a044-c9ab6f9f0a4b';
const accountB = '9d1c0a77-3d31-4f4e-9a5e-4c2b0c3f1f77';
const orgId = '6b7fd26e-ae90-4d4c-9d8e-e95c15db89e1';
const deviceId = 'd93d90c1-a120-4c72-89ee-5c7d16efea31';

async function sessionTokenFor(accountId: string, userId: string): Promise<string> {
  const issued = await issueAuthSession({
    account_id: accountId,
    user_id: userId,
    role: 'developer',
    base_role: 'developer',
    display_name: userId,
    auth_provider: 'local',
    source: 'custom'
  });

  return issued.access_token;
}

async function seedAccount(accountId: string, membershipId: string, name: string): Promise<void> {
  await upsertAccountProfile({
    accountId,
    displayName: name,
    primaryEmail: `${name.toLowerCase()}@example.com`,
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

async function registerAndLinkDevice(accountId: string, token: string): Promise<void> {
  const registered = await request(app).post('/api/device/register').send({
    deviceId,
    machineName: 'ALICE-BOX',
    platform: 'windows',
    agentVersion: '1.0.0'
  });
  expect(registered.status).toBe(200);

  const linked = await request(app)
    .post('/api/device/link-account')
    .set('authorization', `Bearer ${token}`)
    .send({ deviceId, accountId, orgId });
  expect(linked.status).toBe(200);
}

describe('device credentials', () => {
  beforeEach(async () => {
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

    await upsertOrganizationProfile({
      orgId,
      orgName: 'PORTA Labs',
      orgSlug: 'porta-labs',
      planTier: 'pro',
      billingAccountId: 'billing-1',
      createdAt: '2026-03-11T12:00:00.000Z',
      updatedAt: '2026-03-11T12:00:00.000Z'
    });
  });

  describe('secret hashing', () => {
    it('stores only a hash and verifies the plaintext against it', () => {
      const secret = generateDeviceSecret();
      const hash = hashDeviceSecret(secret);

      expect(hash).not.toBe(secret);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(deviceSecretMatches(secret, hash)).toBe(true);
      expect(deviceSecretMatches(`${secret}x`, hash)).toBe(false);
      expect(deviceSecretMatches('', hash)).toBe(false);
    });

    it('produces a different secret every time', () => {
      const secrets = new Set(Array.from({ length: 25 }, () => generateDeviceSecret()));
      expect(secrets.size).toBe(25);
    });

    // A short or malformed stored hash must not throw out of timingSafeEqual.
    it('returns false rather than throwing on a malformed stored hash', () => {
      expect(deviceSecretMatches(generateDeviceSecret(), 'not-a-hash')).toBe(false);
      expect(deviceSecretMatches(generateDeviceSecret(), '')).toBe(false);
    });
  });

  describe('POST /api/device/issue-credential', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(app).post('/api/device/issue-credential').send({ deviceId });

      expect(response.status).toBe(401);
      expect(response.body.error_code).toBe('SESSION_REQUIRED');
    });

    it('issues a secret once for a device the session owns, and stores only the hash', async () => {
      const token = await sessionTokenFor(accountA, 'alice@example.com');
      await seedAccount(accountA, 'f86b5272-1f29-4a52-a7af-8382d800d448', 'Alice');
      await registerAndLinkDevice(accountA, token);

      const response = await request(app)
        .post('/api/device/issue-credential')
        .set('authorization', `Bearer ${token}`)
        .send({ deviceId });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(typeof response.body.deviceSecret).toBe('string');
      expect(response.body.deviceSecret.length).toBeGreaterThan(20);

      const stored = await getDeviceCredential(deviceId);
      expect(stored).not.toBeNull();
      expect(stored!.secretHash).not.toBe(response.body.deviceSecret);
      expect(deviceSecretMatches(response.body.deviceSecret, stored!.secretHash)).toBe(true);
    });

    it('rotates the secret on re-issue and invalidates the previous one', async () => {
      const token = await sessionTokenFor(accountA, 'alice@example.com');
      await seedAccount(accountA, 'f86b5272-1f29-4a52-a7af-8382d800d448', 'Alice');
      await registerAndLinkDevice(accountA, token);

      const first = await request(app)
        .post('/api/device/issue-credential')
        .set('authorization', `Bearer ${token}`)
        .send({ deviceId });
      const second = await request(app)
        .post('/api/device/issue-credential')
        .set('authorization', `Bearer ${token}`)
        .send({ deviceId });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.body.deviceSecret).not.toBe(second.body.deviceSecret);

      const stored = await getDeviceCredential(deviceId);
      expect(deviceSecretMatches(second.body.deviceSecret, stored!.secretHash)).toBe(true);
      expect(deviceSecretMatches(first.body.deviceSecret, stored!.secretHash)).toBe(false);
    });

    it('refuses to issue a credential for another account\'s device', async () => {
      const aliceToken = await sessionTokenFor(accountA, 'alice@example.com');
      const bobToken = await sessionTokenFor(accountB, 'bob@example.com');
      await seedAccount(accountA, 'f86b5272-1f29-4a52-a7af-8382d800d448', 'Alice');
      await seedAccount(accountB, '3c2a1f10-95f7-4c02-9d1a-6b2f0e5c7d31', 'Bob');
      await registerAndLinkDevice(accountA, aliceToken);

      const response = await request(app)
        .post('/api/device/issue-credential')
        .set('authorization', `Bearer ${bobToken}`)
        .send({ deviceId });

      expect(response.status).toBe(403);
      expect(response.body.error_code).toBe('ACCOUNT_MISMATCH');
      expect(await getDeviceCredential(deviceId)).toBeNull();
    });

    it('refuses an unlinked device', async () => {
      const token = await sessionTokenFor(accountA, 'alice@example.com');
      await seedAccount(accountA, 'f86b5272-1f29-4a52-a7af-8382d800d448', 'Alice');

      const registered = await request(app).post('/api/device/register').send({
        deviceId,
        machineName: 'ALICE-BOX',
        platform: 'windows',
        agentVersion: '1.0.0'
      });
      expect(registered.status).toBe(200);

      const response = await request(app)
        .post('/api/device/issue-credential')
        .set('authorization', `Bearer ${token}`)
        .send({ deviceId });

      expect(response.status).toBe(403);
      expect(response.body.error_code).toBe('ACCOUNT_MISMATCH');
    });

    it('404s for a device that was never registered', async () => {
      const token = await sessionTokenFor(accountA, 'alice@example.com');
      await seedAccount(accountA, 'f86b5272-1f29-4a52-a7af-8382d800d448', 'Alice');

      const response = await request(app)
        .post('/api/device/issue-credential')
        .set('authorization', `Bearer ${token}`)
        .send({ deviceId: 'ba0f4f2c-6d43-4a35-8e4a-2c1f2f0a9b77' });

      expect(response.status).toBe(404);
      expect(response.body.error_code).toBe('DEVICE_NOT_FOUND');
    });

    it('requires a deviceId', async () => {
      const token = await sessionTokenFor(accountA, 'alice@example.com');

      const response = await request(app)
        .post('/api/device/issue-credential')
        .set('authorization', `Bearer ${token}`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error_code).toBe('VALIDATION_ERROR');
    });
  });
});
