import * as fs from 'node:fs';
import * as path from 'node:path';
import * as supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetSLOGateStateForTests } from '../src/core/sloEvaluator.js';
import { clearGrowthEventStoreForTests } from '../src/store/growthEventStore.js';
import { loadRuntimeState, resetRuntimeStateForTests } from '../src/store/runtimeState.js';
import { clearAccountStoreForTests, upsertAccountProfile } from '../src/store/accountStore.js';
import { clearAccountActiveDayStoreForTests } from '../src/store/accountActiveDayStore.js';
import { clearOrganizationStoreForTests } from '../src/store/organizationStore.js';
import { clearMembershipStoreForTests } from '../src/store/membershipStore.js';
import { clearDeviceStoreForTests, upsertDeviceProfile } from '../src/store/deviceStore.js';
import { clearConsentRecordStoreForTests } from '../src/store/consentRecordStore.js';
import { clearAuthSessionStoreForTests } from '../src/core/authSessionStore.js';
import { clearDeviceCredentialStoreForTests, issueDeviceSecret } from '../src/store/deviceCredentialStore.js';

const dataDir = path.resolve('.data');
const request = (supertest as unknown as { default: typeof supertest }).default as unknown as typeof import('supertest');
const app = createApp();

const accountId = '2094e8ad-74f6-45fc-a044-c9ab6f9f0a4b';
const otherAccountId = '9d1c0a77-3d31-4f4e-9a5e-4c2b0c3f1f77';
const orgId = '6b7fd26e-ae90-4d4c-9d8e-e95c15db89e1';
const deviceId = 'd93d90c1-a120-4c72-89ee-5c7d16efea31';

// These routes are the ones requireDeviceAuth now guards. In log mode every one of them must
// still answer an uncredentialed agent, or the deploy locks the current fleet out.
const guardedPosts: Array<{ route: string; body: unknown }> = [
  { route: '/api/agent/categories/resolve', body: { tokens: ['chrome'] } },
  { route: '/api/agent/action-events', body: [] },
  { route: '/api/agent/daily-stats', body: {} },
  { route: '/api/agent/narrative', body: {} },
  { route: '/api/agent/daily-digest', body: {} }
];

async function seedLinkedDevice(linkedAccountId: string): Promise<string> {
  await upsertAccountProfile({
    accountId: linkedAccountId,
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

  await upsertDeviceProfile({
    deviceId,
    orgId,
    machineName: 'ALICE-BOX',
    deviceDisplayName: 'Alice Workstation',
    platform: 'windows',
    agentVersion: '1.2.120',
    status: 'active',
    firstSeenAt: '2026-03-11T12:00:00.000Z',
    lastSeenAt: '2026-07-28T12:00:00.000Z',
    currentAccountId: linkedAccountId,
    revokedAt: null,
    createdAt: '2026-03-11T12:00:00.000Z',
    updatedAt: '2026-07-28T12:00:00.000Z'
  });

  const { secret } = await issueDeviceSecret(deviceId);
  return secret;
}

describe('device auth on the remaining agent routes', () => {
  beforeEach(() => {
    delete process.env.PORTA_DEVICE_AUTH_MODE;
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

  afterEach(() => {
    delete process.env.PORTA_DEVICE_AUTH_MODE;
  });

  describe('log mode (the default)', () => {
    it('lets an uncredentialed agent through on every guarded route', async () => {
      for (const { route, body } of guardedPosts) {
        const response = await request(app).post(route).send(body);
        expect(response.status, `${route} must not 401 in log mode`).not.toBe(401);
      }
    });

    it('lets an uncredentialed agent read user-context', async () => {
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

      const response = await request(app).get(`/api/agent/user-context?accountId=${accountId}`);

      expect(response.status).toBe(200);
    });

    it('lets a device read an account it is not linked to, but counts it', async () => {
      const secret = await seedLinkedDevice(otherAccountId);

      const response = await request(app)
        .get(`/api/agent/user-context?accountId=${accountId}`)
        .set('x-porta-device-id', deviceId)
        .set('x-porta-device-secret', secret);

      expect(response.status).toBe(200);
    });
  });

  describe('enforce mode', () => {
    beforeEach(() => {
      process.env.PORTA_DEVICE_AUTH_MODE = 'enforce';
    });

    it('refuses an uncredentialed agent on every guarded route', async () => {
      for (const { route, body } of guardedPosts) {
        const response = await request(app).post(route).send(body);
        expect(response.status, `${route} must 401 in enforce mode`).toBe(401);
        expect(response.body.error_code).toBe('DEVICE_CREDENTIAL_REQUIRED');
      }
    });

    it('refuses a wrong secret', async () => {
      await seedLinkedDevice(accountId);

      const response = await request(app)
        .post('/api/agent/daily-stats')
        .set('x-porta-device-id', deviceId)
        .set('x-porta-device-secret', 'not-the-secret')
        .send({});

      expect(response.status).toBe(401);
    });

    it('admits a credentialed agent', async () => {
      const secret = await seedLinkedDevice(accountId);

      const response = await request(app)
        .post('/api/agent/categories/resolve')
        .set('x-porta-device-id', deviceId)
        .set('x-porta-device-secret', secret)
        .send({ tokens: ['chrome'] });

      expect(response.status).not.toBe(401);
    });

    // The hole this route had: an accountId off the query string with no credential at all,
    // returning that person's weak hour, streak length and strong-window bounds.
    it('refuses user-context for an account the device is not linked to', async () => {
      const secret = await seedLinkedDevice(otherAccountId);

      const response = await request(app)
        .get(`/api/agent/user-context?accountId=${accountId}`)
        .set('x-porta-device-id', deviceId)
        .set('x-porta-device-secret', secret);

      expect(response.status).toBe(403);
      expect(response.body.error_code).toBe('DEVICE_ACCOUNT_MISMATCH');
    });

    it('refuses user-context with no credential', async () => {
      const response = await request(app).get(`/api/agent/user-context?accountId=${accountId}`);

      expect(response.status).toBe(401);
    });

    it('allows user-context for the account the device is actually linked to', async () => {
      const secret = await seedLinkedDevice(accountId);

      const response = await request(app)
        .get(`/api/agent/user-context?accountId=${accountId}`)
        .set('x-porta-device-id', deviceId)
        .set('x-porta-device-secret', secret);

      expect(response.status).toBe(200);
    });
  });
});
