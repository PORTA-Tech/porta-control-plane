import * as fs from 'node:fs';
import * as path from 'node:path';
import * as supertest from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetSLOGateStateForTests } from '../src/core/sloEvaluator.js';
import { clearGrowthEventStoreForTests, listGrowthEventsForAccount } from '../src/store/growthEventStore.js';
import { loadRuntimeState, resetRuntimeStateForTests, runtimeState } from '../src/store/runtimeState.js';
import { appendLedgerRecord } from '../src/core/auditLedger.js';
import { clearMachineSummaryStoreForTests } from '../src/store/machineSummaryStore.js';
import { clearMachineActionStoreForTests } from '../src/store/machineActionStore.js';
import { clearAccountStoreForTests, upsertAccountProfile } from '../src/store/accountStore.js';
import { clearAccountActiveDayStoreForTests, listAccountActiveDaysForAccount } from '../src/store/accountActiveDayStore.js';
import { clearOrganizationStoreForTests, upsertOrganizationProfile } from '../src/store/organizationStore.js';
import { clearMembershipStoreForTests, upsertMembership } from '../src/store/membershipStore.js';
import { clearDeviceStoreForTests, getDeviceProfile } from '../src/store/deviceStore.js';

const dataDir = path.resolve('.data');
const request = (supertest as unknown as { default: typeof supertest }).default as unknown as typeof import('supertest');
const app = createApp();

function withOperatorHeaders(req: supertest.Test): supertest.Test {
  return req.set('x-operator-id', 'operator-int').set('x-operator-role', 'operator');
}

function withAdminHeaders(req: supertest.Test): supertest.Test {
  return req.set('x-operator-id', 'admin-int').set('x-operator-role', 'admin');
}

describe('endpoint integration', () => {
  beforeEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    resetRuntimeStateForTests();
    resetSLOGateStateForTests();
    clearMachineSummaryStoreForTests();
    clearMachineActionStoreForTests();
    clearAccountStoreForTests();
    clearGrowthEventStoreForTests();
    clearAccountActiveDayStoreForTests();
    clearOrganizationStoreForTests();
    clearMembershipStoreForTests();
    clearDeviceStoreForTests();
    delete process.env.CONTROL_PLANE_ADAPTER_EXPANSION_ENABLED;
    loadRuntimeState();
  });

  it('ingests machine summaries and exposes them through fleet read endpoints', async () => {
    await upsertAccountProfile({
      accountId: '34f55d95-d7c0-4d2e-86f5-c2a06dbf2f9f',
      displayName: 'Alice Porter',
      primaryEmail: 'alice@porta.test',
      emailVerified: true,
      avatarUrl: null,
      status: 'active',
      authProvider: 'local',
      lastLoginAt: '2026-03-11T10:00:00.000Z',
      createdAt: '2026-03-11T09:00:00.000Z',
      updatedAt: '2026-03-11T10:00:00.000Z'
    });
    await upsertOrganizationProfile({
      orgId: '9be62dd8-ea7b-47ca-b818-e7c8f8477d0b',
      orgName: 'PORTA Labs',
      orgSlug: 'porta-labs',
      planTier: 'pro',
      billingAccountId: 'billing-1',
      createdAt: '2026-03-11T09:00:00.000Z',
      updatedAt: '2026-03-11T09:00:00.000Z'
    });
    await upsertMembership({
      membershipId: '8d2d768b-d6e7-4137-a2ca-e08063eff520',
      accountId: '34f55d95-d7c0-4d2e-86f5-c2a06dbf2f9f',
      orgId: '9be62dd8-ea7b-47ca-b818-e7c8f8477d0b',
      role: 'admin',
      status: 'active',
      invitedAt: null,
      joinedAt: '2026-03-11T09:10:00.000Z',
      invitedByAccountId: null,
      createdAt: '2026-03-11T09:10:00.000Z',
      updatedAt: '2026-03-11T09:10:00.000Z'
    });
    const reportedAtUtc = new Date().toISOString();
    const heartbeatUtc = new Date(Date.now() - 1_000).toISOString();
    const activityUtc = new Date(Date.now() - 2_000).toISOString();
    const summary = {
      deviceId: 'd26b9f02-34b7-41c3-9dd4-6cbb4d281ac4',
      accountId: '34f55d95-d7c0-4d2e-86f5-c2a06dbf2f9f',
      orgId: '9be62dd8-ea7b-47ca-b818-e7c8f8477d0b',
      machineId: 'machine-a',
      machineName: 'HP-Laptop',
      userName: 'DOMAIN\\alice',
      agentVersion: '1.0.0',
      schemaVersion: '1.0.0',
      policyVersion: 'policy-v2',
      reportedAtUtc,
      agentRunning: true,
      userSessionConnected: true,
      activityDetected: true,
      lastActivityUtc: activityUtc,
      userAgentHeartbeatUtc: heartbeatUtc,
      captureContext: 'UserSession',
      keyboardSignalActive: true,
      mouseSignalActive: true,
      ownershipWarning: null,
      captureFailureReason: null,
      lastError: null,
      backendConnected: true,
      localApiAuthReady: true,
      dbMigrationFailed: false,
      taskContinuityScore: 0.88,
      taskContinuitySeconds: 2400,
      continuityState: 'keep',
      deepWorkActive: true,
      overloadLikelihood: 0.34,
      overloadActive: false,
      breakNeeded: true,
      breakPendingAction: 'stretch_break_suggestion',
      breakPendingReasonCode: 'delivery_boundary_wait',
      calibrationStage: 'calibrated',
      trustTier: 'high',
      modelConfidence: 0.87,
      signalQualityScore: 0.91,
      partialData: false,
      missingMajorChannels: []
    };

    const ingest = await request(app).post('/api/agent/machine-summary').send(summary);
    expect(ingest.status).toBe(202);

    const listResponse = await withOperatorHeaders(request(app).get('/v1/machines/summary'));
    expect(listResponse.status).toBe(200);
    expect(listResponse.body).toHaveLength(1);
    expect(listResponse.body[0]?.machineId).toBe('machine-a');
    expect(listResponse.body[0]?.trustTier).toBe('high');
    expect(listResponse.body[0]?.displayName).toBe('Alice Porter');
    expect(listResponse.body[0]?.primaryEmail).toBe('alice@porta.test');
    expect(listResponse.body[0]?.orgName).toBe('PORTA Labs');
    expect(listResponse.body[0]?.role).toBe('admin');
    expect(listResponse.body[0]?.deviceStatus).toBe('active');
    expect(listResponse.body[0]?.deviceRevokedAt).toBeNull();

    const detailResponse = await withOperatorHeaders(request(app).get('/v1/machines/machine-a'));
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.body.machineName).toBe('HP-Laptop');
    expect(detailResponse.body.breakPendingAction).toBe('stretch_break_suggestion');
    expect(detailResponse.body.displayName).toBe('Alice Porter');
    expect(detailResponse.body.deviceStatus).toBe('active');

    const device = await getDeviceProfile('d26b9f02-34b7-41c3-9dd4-6cbb4d281ac4');
    expect(device).not.toBeNull();
    expect(device?.status).toBe('active');
    expect(device?.currentAccountId).toBe('34f55d95-d7c0-4d2e-86f5-c2a06dbf2f9f');
    expect(device?.orgId).toBe('9be62dd8-ea7b-47ca-b818-e7c8f8477d0b');
    expect(device?.machineName).toBe('HP-Laptop');
    expect(device?.agentVersion).toBe('1.0.0');

    const growthEvents = await listGrowthEventsForAccount('34f55d95-d7c0-4d2e-86f5-c2a06dbf2f9f');
    expect(growthEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(['device_linked', 'account_active_day'])
    );
    const activeDays = await listAccountActiveDaysForAccount('34f55d95-d7c0-4d2e-86f5-c2a06dbf2f9f');
    expect(activeDays).toHaveLength(1);
    expect(activeDays[0]?.activityDate).toBe(activityUtc.slice(0, 10));

    const compatibilityResponse = await withOperatorHeaders(request(app).get('/v1/nodes/snapshot'));
    expect(compatibilityResponse.status).toBe(200);
    expect(compatibilityResponse.body).toHaveLength(1);
    expect(compatibilityResponse.body[0]?.node_id).toBe('machine-a');
    expect(compatibilityResponse.body[0]?.degradation_state).toBe('normal');
  });

  it('ingests machine action events and exposes them through fleet action endpoints', async () => {
    await upsertAccountProfile({
      accountId: '34f55d95-d7c0-4d2e-86f5-c2a06dbf2f9f',
      displayName: 'Alice Porter',
      primaryEmail: 'alice@porta.test',
      emailVerified: true,
      avatarUrl: null,
      status: 'active',
      authProvider: 'local',
      lastLoginAt: '2026-03-11T10:00:00.000Z',
      createdAt: '2026-03-11T09:00:00.000Z',
      updatedAt: '2026-03-11T10:00:00.000Z'
    });
    await upsertOrganizationProfile({
      orgId: '9be62dd8-ea7b-47ca-b818-e7c8f8477d0b',
      orgName: 'PORTA Labs',
      orgSlug: 'porta-labs',
      planTier: 'pro',
      billingAccountId: 'billing-1',
      createdAt: '2026-03-11T09:00:00.000Z',
      updatedAt: '2026-03-11T09:00:00.000Z'
    });
    await upsertMembership({
      membershipId: '8d2d768b-d6e7-4137-a2ca-e08063eff520',
      accountId: '34f55d95-d7c0-4d2e-86f5-c2a06dbf2f9f',
      orgId: '9be62dd8-ea7b-47ca-b818-e7c8f8477d0b',
      role: 'admin',
      status: 'active',
      invitedAt: null,
      joinedAt: '2026-03-11T09:10:00.000Z',
      invitedByAccountId: null,
      createdAt: '2026-03-11T09:10:00.000Z',
      updatedAt: '2026-03-11T09:10:00.000Z'
    });
    const events = [
      {
        deviceId: 'd26b9f02-34b7-41c3-9dd4-6cbb4d281ac4',
        accountId: '34f55d95-d7c0-4d2e-86f5-c2a06dbf2f9f',
        orgId: '9be62dd8-ea7b-47ca-b818-e7c8f8477d0b',
        machineId: 'machine-a',
        userName: 'DOMAIN\\alice',
        interventionId: 'int-1',
        action: 'break_suggestion',
        actionCategory: 'suggestion',
        decisionState: 'decided',
        executionState: 'applied',
        verifiedState: 'not_applicable',
        timestampUtc: '2026-03-11T12:00:00.000Z',
        appliedAtUtc: '2026-03-11T12:00:01.000Z',
        errorCode: null,
        policyId: 'break-policy',
        whatChanged: 'Break suggestion displayed to user.',
        howToUndo: 'Dismiss the suggestion overlay.'
      },
      {
        deviceId: 'd26b9f02-34b7-41c3-9dd4-6cbb4d281ac4',
        accountId: '34f55d95-d7c0-4d2e-86f5-c2a06dbf2f9f',
        orgId: '9be62dd8-ea7b-47ca-b818-e7c8f8477d0b',
        machineId: 'machine-a',
        userName: 'DOMAIN\\alice',
        interventionId: 'int-2',
        action: 'deep_work_notifications_suppressed',
        actionCategory: 'automatic_change',
        decisionState: 'decided',
        executionState: 'verified',
        verifiedState: 'verified',
        timestampUtc: '2026-03-11T12:05:00.000Z',
        appliedAtUtc: '2026-03-11T12:05:01.000Z',
        errorCode: null,
        policyId: 'deep-work-policy',
        whatChanged: 'Notifications were suppressed.',
        howToUndo: 'Wait for deep work exit or restore notifications manually.'
      }
    ];

    const ingest = await request(app).post('/api/agent/action-events').send(events);
    expect(ingest.status).toBe(202);
    expect(ingest.body.count).toBe(2);

    const recentResponse = await withOperatorHeaders(request(app).get('/v1/actions/recent'));
    expect(recentResponse.status).toBe(200);
    expect(recentResponse.body).toHaveLength(2);
    expect(recentResponse.body[0]?.interventionId).toBe('int-2');
    expect(recentResponse.body[0]?.displayName).toBe('Alice Porter');
    expect(recentResponse.body[0]?.orgName).toBe('PORTA Labs');
    expect(recentResponse.body[0]?.role).toBe('admin');
    expect(recentResponse.body[0]?.deviceStatus).toBe('active');

    const machineResponse = await withOperatorHeaders(request(app).get('/v1/machines/machine-a/actions'));
    expect(machineResponse.status).toBe(200);
    expect(machineResponse.body).toHaveLength(2);
    expect(machineResponse.body[0]?.action).toBe('deep_work_notifications_suppressed');
    expect(machineResponse.body[0]?.primaryEmail).toBe('alice@porta.test');
    expect(machineResponse.body[0]?.deviceStatus).toBe('active');

    const device = await getDeviceProfile('d26b9f02-34b7-41c3-9dd4-6cbb4d281ac4');
    expect(device).not.toBeNull();
    expect(device?.status).toBe('active');
    expect(device?.currentAccountId).toBe('34f55d95-d7c0-4d2e-86f5-c2a06dbf2f9f');
    expect(device?.orgId).toBe('9be62dd8-ea7b-47ca-b818-e7c8f8477d0b');
    expect(device?.machineName).toBe('machine-a');
    expect(device?.agentVersion).toBe('unknown');
  });

  it('activates an account only after trusted link, consent, and machine activity are observed', async () => {
    const accountId = '34f55d95-d7c0-4d2e-86f5-c2a06dbf2f9f';
    const orgId = '9be62dd8-ea7b-47ca-b818-e7c8f8477d0b';
    const deviceId = 'd26b9f02-34b7-41c3-9dd4-6cbb4d281ac4';

    await upsertAccountProfile({
      accountId,
      displayName: 'Alice Porter',
      primaryEmail: 'alice@porta.test',
      emailVerified: true,
      avatarUrl: null,
      status: 'active',
      authProvider: 'local',
      lastLoginAt: '2026-03-11T10:00:00.000Z',
      createdAt: '2026-03-11T09:00:00.000Z',
      updatedAt: '2026-03-11T10:00:00.000Z'
    });
    await upsertOrganizationProfile({
      orgId,
      orgName: 'PORTA Labs',
      orgSlug: 'porta-labs',
      planTier: 'pro',
      billingAccountId: 'billing-1',
      createdAt: '2026-03-11T09:00:00.000Z',
      updatedAt: '2026-03-11T09:00:00.000Z'
    });
    await upsertMembership({
      membershipId: '8d2d768b-d6e7-4137-a2ca-e08063eff520',
      accountId,
      orgId,
      role: 'admin',
      status: 'active',
      invitedAt: null,
      joinedAt: '2026-03-11T09:10:00.000Z',
      invitedByAccountId: null,
      createdAt: '2026-03-11T09:10:00.000Z',
      updatedAt: '2026-03-11T09:10:00.000Z'
    });

    const registerResponse = await request(app).post('/api/device/register').send({
      deviceId,
      machineName: 'HP-Laptop',
      deviceDisplayName: 'Alice Workstation',
      platform: 'windows',
      agentVersion: '1.0.0'
    });
    expect(registerResponse.status).toBe(200);

    const linkResponse = await request(app).post('/api/device/link-account').send({
      deviceId,
      accountId,
      orgId
    });
    expect(linkResponse.status).toBe(200);

    const consentResponse = await request(app).post('/api/device/register').send({
      deviceId,
      machineName: 'HP-Laptop',
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

    const ingest = await request(app).post('/api/agent/machine-summary').send({
      deviceId,
      accountId,
      orgId,
      machineId: 'machine-activation',
      machineName: 'HP-Laptop',
      userName: 'DOMAIN\\alice',
      agentVersion: '1.0.1',
      schemaVersion: '1.0.0',
      policyVersion: 'policy-v2',
      reportedAtUtc: '2026-03-11T12:06:00.000Z',
      agentRunning: true,
      userSessionConnected: true,
      activityDetected: true,
      lastActivityUtc: '2026-03-11T12:05:30.000Z',
      userAgentHeartbeatUtc: '2026-03-11T12:05:50.000Z',
      captureContext: 'UserSession',
      keyboardSignalActive: true,
      mouseSignalActive: true,
      ownershipWarning: null,
      captureFailureReason: null,
      lastError: null,
      backendConnected: true,
      localApiAuthReady: true,
      dbMigrationFailed: false,
      taskContinuityScore: 0.88,
      taskContinuitySeconds: 2400,
      continuityState: 'keep',
      deepWorkActive: true,
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
      missingMajorChannels: []
    });
    expect(ingest.status).toBe(202);

    const growthEvents = await listGrowthEventsForAccount(accountId);
    expect(growthEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(['device_linked', 'device_capture_consented', 'account_active_day', 'account_activated'])
    );
  });

  it('backfills an unlinked device row for machine summaries without an account link', async () => {
    const summary = {
      deviceId: 'd26b9f02-34b7-41c3-9dd4-6cbb4d281ac4',
      accountId: null,
      orgId: null,
      machineId: 'machine-unlinked',
      machineName: 'Kiosk-1',
      userName: 'unknown',
      agentVersion: '1.0.0',
      schemaVersion: '1.0.0',
      policyVersion: 'policy-v2',
      reportedAtUtc: new Date().toISOString(),
      agentRunning: true,
      userSessionConnected: false,
      activityDetected: false,
      lastActivityUtc: null,
      userAgentHeartbeatUtc: null,
      captureContext: 'Unknown',
      keyboardSignalActive: false,
      mouseSignalActive: false,
      ownershipWarning: null,
      captureFailureReason: 'user_session_missing',
      lastError: null,
      backendConnected: true,
      localApiAuthReady: true,
      dbMigrationFailed: false,
      taskContinuityScore: 0,
      taskContinuitySeconds: 0,
      continuityState: 'reset',
      deepWorkActive: false,
      overloadLikelihood: 0,
      overloadActive: false,
      breakNeeded: false,
      breakPendingAction: null,
      breakPendingReasonCode: null,
      calibrationStage: 'cold',
      trustTier: 'low',
      modelConfidence: 0.2,
      signalQualityScore: 0.2,
      partialData: true,
      missingMajorChannels: ['keyboard', 'mouse']
    };

    const ingest = await request(app).post('/api/agent/machine-summary').send(summary);
    expect(ingest.status).toBe(202);

    const response = await withOperatorHeaders(request(app).get('/v1/machines/machine-unlinked'));
    expect(response.status).toBe(200);
    expect(response.body.displayName).toBeNull();
    expect(response.body.primaryEmail).toBeNull();
    expect(response.body.orgName).toBeNull();
    expect(response.body.role).toBeNull();
    expect(response.body.deviceStatus).toBe('unlinked');
    expect(response.body.deviceRevokedAt).toBeNull();

    const device = await getDeviceProfile('d26b9f02-34b7-41c3-9dd4-6cbb4d281ac4');
    expect(device).not.toBeNull();
    expect(device?.status).toBe('unlinked');
    expect(device?.currentAccountId).toBeNull();
    expect(device?.orgId).toBeNull();
  });

  it('keeps legacy machine rows readable when they predate device identity refs', async () => {
    const summary = {
      machineId: 'machine-legacy',
      machineName: 'Legacy-Kiosk',
      userName: 'unknown',
      agentVersion: '0.9.0',
      schemaVersion: '0.9.0',
      policyVersion: 'policy-v1',
      reportedAtUtc: new Date().toISOString(),
      agentRunning: true,
      userSessionConnected: false,
      activityDetected: false,
      lastActivityUtc: null,
      userAgentHeartbeatUtc: null,
      captureContext: 'Unknown',
      keyboardSignalActive: false,
      mouseSignalActive: false,
      ownershipWarning: null,
      captureFailureReason: 'user_session_missing',
      lastError: null,
      backendConnected: true,
      localApiAuthReady: true,
      dbMigrationFailed: false,
      taskContinuityScore: 0,
      taskContinuitySeconds: 0,
      continuityState: 'reset',
      deepWorkActive: false,
      overloadLikelihood: 0,
      overloadActive: false,
      breakNeeded: false,
      breakPendingAction: null,
      breakPendingReasonCode: null,
      calibrationStage: 'cold',
      trustTier: 'low',
      modelConfidence: 0.2,
      signalQualityScore: 0.2,
      partialData: true,
      missingMajorChannels: ['keyboard', 'mouse']
    };

    const ingest = await request(app).post('/api/agent/machine-summary').send(summary);
    expect(ingest.status).toBe(202);

    const response = await withOperatorHeaders(request(app).get('/v1/machines/machine-legacy'));
    expect(response.status).toBe(200);
    expect(response.body.displayName).toBeNull();
    expect(response.body.primaryEmail).toBeNull();
    expect(response.body.orgName).toBeNull();
    expect(response.body.role).toBeNull();
    expect(response.body.deviceStatus).toBeNull();
    expect(response.body.deviceRevokedAt).toBeNull();
  });

  it('GET /v1/system/health exposes fleet persistence mode for validation gates', async () => {
    const response = await withOperatorHeaders(request(app).get('/v1/system/health'));

    expect(response.status).toBe(200);
    expect(response.body.fleet_reporting.persistence_mode).toBe('memory');
    expect(response.body.fleet_reporting.database_configured).toBe(false);
  });

  it('POST /v1/rollout/rollback executes forced rollback and cooldown', async () => {
    runtimeState.rolloutState = 'PROMOTING';
    runtimeState.currentConfigSeq = 15;
    runtimeState.currentConfigVersion = '2026.02.20.15';
    runtimeState.previousConfigSeq = 14;
    runtimeState.previousConfigVersion = '2026.02.20.14';

    const response = await withOperatorHeaders(request(app).post('/v1/rollout/rollback'));

    expect(response.status).toBe(202);
    expect(response.body.state).toBe('COOLDOWN');
    expect(response.body.actionTaken).toBe(true);
    expect(response.body.rollbackApplied).toBe(true);
    expect(runtimeState.currentConfigSeq).toBe(14);
    expect(runtimeState.currentConfigVersion).toBe('2026.02.20.14');
    expect(runtimeState.rolloutState).toBe('COOLDOWN');
    expect(runtimeState.cooldownUntilUtc).toBeDefined();
  });

  it('POST /v1/slo/evaluate auto-triggers halt and rollback on breach during monitoring', async () => {
    runtimeState.rolloutState = 'MONITORING';
    runtimeState.currentConfigSeq = 30;
    runtimeState.currentConfigVersion = '2026.02.20.30';
    runtimeState.previousConfigSeq = 29;
    runtimeState.previousConfigVersion = '2026.02.20.29';

    const response = await withOperatorHeaders(
      request(app).post('/v1/slo/evaluate').send({
        windowStartUtc: new Date(Date.now() - 30_000).toISOString(),
        windowEndUtc: new Date().toISOString(),
        cohortId: 'canary-1',
        errorRatePct: 1.5,
        p99LatencyMs: 400,
        degradationRatePct: 3.0,
        heartbeatGapIntervals: 4
      })
    );

    expect(response.status).toBe(200);
    expect(response.body.breached).toBe(true);
    expect(response.body.triggerAction).toBe(true);
    expect(response.body.autoAction.actionTaken).toBe(true);
    expect(response.body.rolloutState).toBe('COOLDOWN');
    expect(runtimeState.currentConfigSeq).toBe(29);
    expect(runtimeState.rolloutState).toBe('COOLDOWN');
  });

  it('GET /v1/rollout/dry-run reflects current rollout stage progression', async () => {
    runtimeState.rolloutState = 'HALTED';

    const response = await withOperatorHeaders(request(app).get('/v1/rollout/dry-run'));

    expect(response.status).toBe(200);
    expect(response.body.rollout_stage_progression_preview).toEqual(['ROLLED_BACK', 'COOLDOWN', 'IDLE']);
    expect(response.body.cohorts_impacted).toContain('stable');
  });

  it('GET /v1/config/diff-preview returns backend diff keys and hash fingerprint', async () => {
    runtimeState.currentConfigSeq = 10;
    runtimeState.currentConfigVersion = '2026.02.20.10';

    appendLedgerRecord({
      configSeq: 10,
      configVersion: '2026.02.20.10',
      appliedAtUtc: new Date().toISOString(),
      issuerId: 'operator-int',
      payload: { features: { alpha: true, beta: true }, timeoutMs: 1000 },
      rolloutStatus: 'completed'
    });

    appendLedgerRecord({
      configSeq: 11,
      configVersion: '2026.02.20.11',
      appliedAtUtc: new Date().toISOString(),
      issuerId: 'operator-int',
      payload: { features: { alpha: false, gamma: true }, timeoutMs: 1000, retries: 3 },
      rolloutStatus: 'pending'
    });

    const response = await withOperatorHeaders(request(app).get('/v1/config/diff-preview').query({ targetConfigSeq: 11 }));

    expect(response.status).toBe(200);
    expect(response.body.current_config_seq).toBe(10);
    expect(response.body.target_config_seq).toBe(11);
    expect(response.body.added_keys).toContain('features.gamma');
    expect(response.body.modified_keys).toContain('features.alpha');
    expect(response.body.removed_keys).toContain('features.beta');
    expect(typeof response.body.hash_fingerprint).toBe('string');
    expect(response.body.hash_fingerprint.length).toBeGreaterThan(0);
  });

  it('rollout mutation actions are logged server-side', async () => {
    runtimeState.rolloutState = 'IDLE';

    const mutate = await withOperatorHeaders(request(app).post('/v1/rollout/promote'));
    expect([200, 202]).toContain(mutate.status);

    const audit = await withAdminHeaders(request(app).get('/v1/audit/rollout-events').query({ limit: 50 }));
    expect(audit.status).toBe(200);
    expect(Array.isArray(audit.body)).toBe(true);
    expect(audit.body.some((event: { action?: string }) => event.action === 'rollout.transition')).toBe(true);
  });

  it('GET /v1/config/integrity-active exposes active config integrity fields and status', async () => {
    runtimeState.currentConfigSeq = 10;
    runtimeState.currentConfigVersion = '2026.02.20.10';
    runtimeState.currentConfigIssuerId = 'operator-int';
    runtimeState.currentConfigExpiresAtUtc = new Date(Date.now() + 30 * 60_000).toISOString();
    runtimeState.currentConfigSignatureValid = true;
    runtimeState.previousConfigSeq = 9;
    runtimeState.previousConfigVersion = '2026.02.20.09';

    appendLedgerRecord({
      configSeq: 9,
      configVersion: '2026.02.20.09',
      appliedAtUtc: new Date().toISOString(),
      issuerId: 'operator-int',
      payload: { flags: { a: true } },
      rolloutStatus: 'completed'
    });
    appendLedgerRecord({
      configSeq: 10,
      configVersion: '2026.02.20.10',
      appliedAtUtc: new Date().toISOString(),
      issuerId: 'operator-int',
      payload: { flags: { a: false, b: true } },
      rolloutStatus: 'completed'
    });

    const response = await withOperatorHeaders(request(app).get('/v1/config/integrity-active'));

    expect(response.status).toBe(200);
    expect(response.body.config_seq).toBe(10);
    expect(response.body.config_version).toBe('2026.02.20.10');
    expect(response.body.issuer).toBe('operator-int');
    expect(response.body.signature_validity).toBe(true);
    expect(response.body.hash_fingerprint.length).toBeGreaterThan(0);
    expect(response.body.full_diff_from_previous.modified_keys).toContain('flags.a');
    expect(response.body.full_diff_from_previous.added_keys).toContain('flags.b');
    expect(response.body.integrity_status).toBe('verified');
  });

  it('GET /v1/audit/ledger-view supports immutable filtered ledger rows', async () => {
    await withOperatorHeaders(request(app).post('/v1/rollout/promote'));
    await withOperatorHeaders(request(app).post('/v1/rollout/halt'));

    const response = await withAdminHeaders(
      request(app).get('/v1/audit/ledger-view').query({
        actor: 'operator-int',
        action: 'rollout.transition'
      })
    );

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThan(0);
    expect(response.body[0]).toHaveProperty('action');
    expect(response.body[0]).toHaveProperty('actor');
    expect(response.body[0]).toHaveProperty('timestamp');
    expect(response.body[0]).toHaveProperty('cohort');
    expect(response.body[0]).toHaveProperty('previous_state');
    expect(response.body[0]).toHaveProperty('resulting_state');
    expect(response.body[0]).toHaveProperty('correlation_id');
  });

  it('POST /v1/adapter/controls blocks activation bypass when not in PROMOTING', async () => {
    process.env.CONTROL_PLANE_ADAPTER_EXPANSION_ENABLED = 'true';
    runtimeState.rolloutState = 'IDLE';
    runtimeState.adapterControls.featureAdapterEnabled = false;

    const response = await withOperatorHeaders(
      request(app).post('/v1/adapter/controls').send({
        feature_adapter_enabled: true,
        allowed_cohorts: ['canary-1'],
        rate_limit: 100,
        circuit_breaker_threshold: 5,
        schema_version: '1.0.0'
      })
    );

    expect(response.status).toBe(409);
  });

  it('POST /v1/adapter/controls allows activation in PROMOTING state when gate is enabled', async () => {
    process.env.CONTROL_PLANE_ADAPTER_EXPANSION_ENABLED = 'true';
    runtimeState.rolloutState = 'PROMOTING';
    runtimeState.adapterControls.featureAdapterEnabled = false;

    const response = await withOperatorHeaders(
      request(app).post('/v1/adapter/controls').send({
        feature_adapter_enabled: true,
        allowed_cohorts: ['canary-1', 'canary-5'],
        rate_limit: 120,
        circuit_breaker_threshold: 8,
        schema_version: '1.1.0'
      })
    );

    expect(response.status).toBe(200);
    expect(response.body.feature_adapter_enabled).toBe(true);
    expect(response.body.rollout_state).toBe('PROMOTING');
  });

  it('adapter observability exposes backend-authoritative circuit breaker state and replay log access', async () => {
    process.env.CONTROL_PLANE_ADAPTER_EXPANSION_ENABLED = 'true';
    runtimeState.rolloutState = 'PROMOTING';
    await withOperatorHeaders(
      request(app).post('/v1/adapter/controls').send({
        feature_adapter_enabled: true,
        allowed_cohorts: ['canary-1'],
        rate_limit: 100,
        circuit_breaker_threshold: 1,
        schema_version: '1.0.0'
      })
    );

    const observability = await withOperatorHeaders(request(app).get('/v1/adapter/observability'));
    expect(observability.status).toBe(200);
    const canary = observability.body.find((row: { cohort: string }) => row.cohort === 'canary-1');
    expect(canary).toBeDefined();
    expect(canary.circuit_breaker_state).toBe('CLOSED');

    const replayLog = await withOperatorHeaders(request(app).get('/v1/adapter/replay-log').query({ cohort: 'canary-1' }));
    expect(replayLog.status).toBe(200);
    expect(Array.isArray(replayLog.body)).toBe(true);
  });

  it('adapter promotion path advances only when backend guards allow it', async () => {
    process.env.CONTROL_PLANE_ADAPTER_EXPANSION_ENABLED = 'true';
    runtimeState.rolloutState = 'PROMOTING';
    runtimeState.adapterControls.featureAdapterEnabled = true;
    runtimeState.adapterControls.promotionStage = 'CANARY';
    runtimeState.adapterControls.allowedCohorts = ['canary-1', 'canary-5'];
    const advanced = await withOperatorHeaders(request(app).post('/v1/adapter/promotion-path'));
    expect(advanced.status).toBe(200);
    expect(typeof advanced.body.advanced).toBe('boolean');
    expect(['CANARY', 'LIMITED']).toContain(advanced.body.stage);
    expect(Array.isArray(advanced.body.guard_reasons)).toBe(true);
  });
});
