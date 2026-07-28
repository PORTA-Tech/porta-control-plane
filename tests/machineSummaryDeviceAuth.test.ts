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
import { clearDeviceStoreForTests, getDeviceProfile } from '../src/store/deviceStore.js';
import { clearConsentRecordStoreForTests } from '../src/store/consentRecordStore.js';
import { clearAuthSessionStoreForTests, issueAuthSession } from '../src/core/authSessionStore.js';
import { clearDeviceCredentialStoreForTests } from '../src/store/deviceCredentialStore.js';

const dataDir = path.resolve('.data');
const request = (supertest as unknown as { default: typeof supertest }).default as unknown as typeof import('supertest');
const app = createApp();

const accountId = '2094e8ad-74f6-45fc-a044-c9ab6f9f0a4b';
const orgId = '6b7fd26e-ae90-4d4c-9d8e-e95c15db89e1';
const deviceId = 'd93d90c1-a120-4c72-89ee-5c7d16efea31';
const machineId = 'MACHINE-01';

function summaryPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    machineId,
    machineName: 'ALICE-BOX',
    agentVersion: '1.2.120',
    reportedAtUtc: '2026-07-28T12:00:00.000Z',
    deviceId,
    accountId,
    orgId,
    userName: 'DOMAIN\alice',
    schemaVersion: '1.0.0',
    policyVersion: 'policy-v2',
    agentRunning: true,
    userSessionConnected: true,
    activityDetected: true,
    lastActivityUtc: '2026-07-28T11:59:30.000Z',
    userAgentHeartbeatUtc: '2026-07-28T11:59:50.000Z',
    captureContext: 'UserSession',
    keyboardSignalActive: true,
    mouseSignalActive: true,
    ownershipWarning: null,
    captureFailureReason: null,
    lastError: null,
    backendConnected: true,
    localApiAuthReady: true,
    dbMigrationFailed: false,
    focusEpisodeQuality: 0.88,
    focusEpisodeSeconds: 2400,
    focusEpisodeState: 'keep',
    attentionSegmentKind: 'focus',
    attentionSegmentSeconds: 0,
    distractionEpisodeActive: false,
    distractionEpisodeSeconds: 0,
    taskContinuityScore: 0.88,
    taskContinuitySeconds: 2400,
    continuityState: 'keep',
    deepWorkActive: true,
    pressureLevel: 0.52,
    pressureConfidence: 0.87,
    overloadLikelihood: 0.34,
    overloadActive: false,
    breakNeeded: false,
    breakPendingAction: null,
    breakPendingReasonCode: null,
    calibrationStage: 'calibrated',
    trustTier: 'high',
    modelConfidence: 0.87,
    signalQualityScore: 0.91,
    partialData: false,
    missingMajorChannels: [],
    ...overrides
  };
}

async function seedLinkedDevice(): Promise<string> {
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

  const { access_token: token } = await issueAuthSession({
    account_id: accountId,
    user_id: 'alice@example.com',
    role: 'developer',
    base_role: 'developer',
    display_name: 'Alice',
    auth_provider: 'local',
    source: 'custom'
  });

  await request(app).post('/api/device/register').send({
    deviceId,
    machineName: 'ALICE-BOX',
    platform: 'windows',
    agentVersion: '1.2.120'
  });

  const linked = await request(app)
    .post('/api/device/link-account')
    .set('authorization', `Bearer ${token}`)
    .send({ deviceId, accountId, orgId });
  expect(linked.status).toBe(200);

  const issued = await request(app)
    .post('/api/device/issue-credential')
    .set('authorization', `Bearer ${token}`)
    .send({ deviceId });
  expect(issued.status).toBe(200);

  return issued.body.deviceSecret as string;
}

describe('machine-summary device auth tiers', () => {
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

  // The unlinked-device case: a machine that installed and was never signed into must stay
  // visible, because that is precisely the machine you need to see during a rollout.
  it('accepts an uncredentialed report so the machine stays visible', async () => {
    const response = await request(app).post('/api/agent/machine-summary').send(summaryPayload());

    expect(response.status).toBe(202);
    expect(response.body.accepted).toBe(true);
    expect(response.body.machineId).toBe(machineId);
  });

  it('discards the caller-supplied account on an uncredentialed report', async () => {
    await request(app).post('/api/agent/machine-summary').send(summaryPayload());

    const device = await getDeviceProfile(deviceId);
    expect(device).not.toBeNull();
    expect(device!.currentAccountId).toBeNull();
    expect(device!.orgId).toBeNull();
  });

  it('writes no account-attributed growth events without a credential', async () => {
    await request(app).post('/api/agent/machine-summary').send(summaryPayload());

    expect(await listGrowthEventsForAccount(accountId)).toHaveLength(0);
  });

  it('reconciles the account when the device credential is valid', async () => {
    const secret = await seedLinkedDevice();

    const response = await request(app)
      .post('/api/agent/machine-summary')
      .set('x-porta-device-id', deviceId)
      .set('x-porta-device-secret', secret)
      .send(summaryPayload());

    expect(response.status).toBe(202);

    const device = await getDeviceProfile(deviceId);
    expect(device!.currentAccountId).toBe(accountId);
    expect(device!.orgId).toBe(orgId);
  });

  it('records growth events only on the credentialed path', async () => {
    const secret = await seedLinkedDevice();

    await request(app)
      .post('/api/agent/machine-summary')
      .set('x-porta-device-id', deviceId)
      .set('x-porta-device-secret', secret)
      .send(summaryPayload({ machineId: 'MACHINE-GROWTH' }));

    const events = await listGrowthEventsForAccount(accountId);
    expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining(['machine_installed']));
  });

  it('treats a wrong secret as anonymous rather than trusting it', async () => {
    await request(app).post('/api/device/register').send({
      deviceId,
      machineName: 'ALICE-BOX',
      platform: 'windows',
      agentVersion: '1.2.120'
    });

    const response = await request(app)
      .post('/api/agent/machine-summary')
      .set('x-porta-device-id', deviceId)
      .set('x-porta-device-secret', 'not-the-secret')
      .send(summaryPayload({ machineId: 'MACHINE-WRONGSECRET' }));

    expect(response.status).toBe(202);
    const device = await getDeviceProfile(deviceId);
    expect(device!.currentAccountId).toBeNull();
    expect(await listGrowthEventsForAccount(accountId)).toHaveLength(0);
  });

  // A credential proves exactly one device. It must not become a way to write account rows
  // for a different device id.
  it('will not let one device credential write another device\'s report', async () => {
    const secret = await seedLinkedDevice();
    const otherDeviceId = 'ba0f4f2c-6d43-4a35-8e4a-2c1f2f0a9b77';

    const response = await request(app)
      .post('/api/agent/machine-summary')
      .set('x-porta-device-id', deviceId)
      .set('x-porta-device-secret', secret)
      .send(summaryPayload({ deviceId: otherDeviceId, machineId: 'MACHINE-02' }));

    expect(response.status).toBe(202);

    const other = await getDeviceProfile(otherDeviceId);
    expect(other).not.toBeNull();
    expect(other!.currentAccountId).toBeNull();
  });
});
