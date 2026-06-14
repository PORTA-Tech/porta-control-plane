import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as supertest from 'supertest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import SwaggerParser from '@apidevtools/swagger-parser';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { registerAuthUser } from '../src/core/authSessionStore.js';
import { maybeActivateAccount, recordAccountActiveDay, recordLifecycleGrowthEvent } from '../src/core/growthService.js';
import { resetSLOGateStateForTests } from '../src/core/sloEvaluator.js';
import { clearAccountStoreForTests, upsertAccountProfile } from '../src/store/accountStore.js';
import { clearAccountActiveDayStoreForTests } from '../src/store/accountActiveDayStore.js';
import { clearConsentRecordStoreForTests, upsertConsentRecord } from '../src/store/consentRecordStore.js';
import { clearDeviceStoreForTests, upsertDeviceProfile } from '../src/store/deviceStore.js';
import { clearGrowthEventStoreForTests } from '../src/store/growthEventStore.js';
import { clearMembershipStoreForTests, upsertMembership } from '../src/store/membershipStore.js';
import { clearOrganizationStoreForTests, upsertOrganizationProfile } from '../src/store/organizationStore.js';
import { loadRuntimeState, resetRuntimeStateForTests, runtimeState } from '../src/store/runtimeState.js';

const dataDir = path.resolve('.data');
const request = (supertest as unknown as { default: typeof supertest }).default as unknown as typeof import('supertest');
const app = createApp();
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

interface OpenApiOperation {
  responses?: Record<string, { content?: { 'application/json'?: { schema?: unknown } } }>;
}

interface OpenApiDoc {
  paths?: Record<string, Record<string, OpenApiOperation>>;
}

let openApi: OpenApiDoc;

async function seedGrowthUserForContract(label: string): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const userId = `${label}.${suffix}@contract.test`;
  const orgId = randomUUID();
  const deviceId = randomUUID();
  const accountRegisteredAt = '2026-03-10T09:00:00.000Z';
  const membershipJoinedAt = '2026-03-10T09:05:00.000Z';
  const deviceLinkedAt = '2026-03-10T09:10:00.000Z';
  const consentedAt = '2026-03-10T09:15:00.000Z';
  const activityAt = '2026-03-11T12:00:00.000Z';

  const created = await registerAuthUser({
    user_id: userId,
    password: 'ValidPass1',
    display_name: `Contract ${label}`,
    role: 'developer'
  });

  if (!created.ok) {
    throw new Error(`Could not seed contract growth user: ${created.error_code}`);
  }

  const accountId = created.user.account_id;
  await upsertAccountProfile({
    accountId,
    displayName: created.user.display_name,
    primaryEmail: userId,
    emailVerified: true,
    avatarUrl: null,
    status: 'active',
    authProvider: 'local',
    lastLoginAt: null,
    createdAt: accountRegisteredAt,
    updatedAt: accountRegisteredAt
  });
  await upsertOrganizationProfile({
    orgId,
    orgName: `Contract Org ${label}`,
    orgSlug: `contract-org-${label}-${suffix}`,
    planTier: 'pro',
    billingAccountId: `billing-${suffix}`,
    createdAt: accountRegisteredAt,
    updatedAt: accountRegisteredAt
  });
  await upsertMembership({
    membershipId: randomUUID(),
    accountId,
    orgId,
    role: 'owner',
    status: 'active',
    invitedAt: null,
    joinedAt: membershipJoinedAt,
    invitedByAccountId: null,
    createdAt: membershipJoinedAt,
    updatedAt: membershipJoinedAt
  });
  await upsertDeviceProfile({
    deviceId,
    orgId,
    machineName: `Contract Device ${label}`,
    deviceDisplayName: `Contract Device ${label}`,
    platform: 'windows',
    agentVersion: '1.0.0',
    status: 'active',
    firstSeenAt: deviceLinkedAt,
    lastSeenAt: deviceLinkedAt,
    currentAccountId: accountId,
    revokedAt: null,
    createdAt: deviceLinkedAt,
    updatedAt: deviceLinkedAt
  });
  await upsertConsentRecord({
    consentId: randomUUID(),
    scope: 'device_capture',
    accountId,
    deviceId,
    orgId,
    consentVersion: 'v1',
    consentState: 'accepted',
    telemetryLevel: 'full',
    consentedAt,
    updatedAt: consentedAt
  });
  await recordLifecycleGrowthEvent({
    eventKey: `account_registered:${accountId}`,
    eventType: 'account_registered',
    accountId,
    userId,
    occurredAtUtc: accountRegisteredAt,
    source: 'test_contract'
  });
  await recordLifecycleGrowthEvent({
    eventKey: `membership_joined:${accountId}:${orgId}`,
    eventType: 'membership_joined',
    accountId,
    userId,
    orgId,
    occurredAtUtc: membershipJoinedAt,
    source: 'test_contract'
  });
  await recordLifecycleGrowthEvent({
    eventKey: `device_linked:${accountId}:${deviceId}:${orgId}`,
    eventType: 'device_linked',
    accountId,
    userId,
    deviceId,
    orgId,
    occurredAtUtc: deviceLinkedAt,
    source: 'test_contract'
  });
  await recordLifecycleGrowthEvent({
    eventKey: `device_capture_consented:${accountId}:${deviceId}:${orgId}:${consentedAt}`,
    eventType: 'device_capture_consented',
    accountId,
    userId,
    deviceId,
    orgId,
    occurredAtUtc: consentedAt,
    source: 'test_contract'
  });
  await recordAccountActiveDay({
    accountId,
    userId,
    orgId,
    machineId: `machine-${suffix}`,
    activityAtUtc: activityAt,
    source: 'test_contract'
  });
  await maybeActivateAccount(accountId);
  return accountId;
}

const TEST_OPERATOR_KEY = 'test-operator-key-openapi';

function withOperatorHeaders(req: supertest.Test): supertest.Test {
  return req
    .set('x-operator-id', 'operator-openapi')
    .set('x-operator-role', 'operator')
    .set('x-operator-key', TEST_OPERATOR_KEY);
}

function withAdminHeaders(req: supertest.Test): supertest.Test {
  return req
    .set('x-operator-id', 'admin-openapi')
    .set('x-operator-role', 'admin')
    .set('x-operator-key', TEST_OPERATOR_KEY);
}

function assertSchema(pathKey: string, method: string, status: number, body: unknown): void {
  const operation = openApi.paths?.[pathKey]?.[method.toLowerCase()];
  expect(operation, `Missing operation for ${method.toUpperCase()} ${pathKey}`).toBeTruthy();

  const response = operation?.responses?.[String(status)];
  expect(response, `Missing response ${status} for ${method.toUpperCase()} ${pathKey}`).toBeTruthy();

  const schema = response?.content?.['application/json']?.schema;
  expect(schema, `Missing JSON schema for ${method.toUpperCase()} ${pathKey} ${status}`).toBeTruthy();

  const validate = ajv.compile(schema as object);
  const ok = validate(body);
  if (!ok) {
    throw new Error(
      `OpenAPI schema mismatch for ${method.toUpperCase()} ${pathKey} ${status}: ${ajv.errorsText(validate.errors)}`
    );
  }
}

describe('openapi contract compliance', () => {
  beforeAll(async () => {
    const openapiPath = path.resolve('vendor', 'api-contracts-local', 'src', 'openapi', 'control-plane.yaml');
    openApi = (await SwaggerParser.dereference(openapiPath)) as OpenApiDoc;
  });

  beforeEach(() => {
    process.env.PORTA_OPERATOR_KEY = TEST_OPERATOR_KEY;
    fs.rmSync(dataDir, { recursive: true, force: true });
    resetRuntimeStateForTests();
    resetSLOGateStateForTests();
    clearAccountStoreForTests();
    clearAccountActiveDayStoreForTests();
    clearConsentRecordStoreForTests();
    clearDeviceStoreForTests();
    clearGrowthEventStoreForTests();
    clearMembershipStoreForTests();
    clearOrganizationStoreForTests();
    delete process.env.CONTROL_PLANE_ADAPTER_EXPANSION_ENABLED;
    loadRuntimeState();
  });

  it('GET /health matches OpenAPI schema', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    assertSchema('/health', 'get', 200, response.body);
  });

  it('GET /v1/rollout/state matches OpenAPI schema', async () => {
    const response = await withOperatorHeaders(request(app).get('/v1/rollout/state'));
    expect(response.status).toBe(200);
    assertSchema('/v1/rollout/state', 'get', 200, response.body);
  });

  it('GET /v1/rollout/dry-run matches OpenAPI schema', async () => {
    const response = await withOperatorHeaders(request(app).get('/v1/rollout/dry-run'));
    expect(response.status).toBe(200);
    assertSchema('/v1/rollout/dry-run', 'get', 200, response.body);
  });

  it('GET /v1/rollout/evaluate matches OpenAPI schema', async () => {
    const response = await withOperatorHeaders(request(app).get('/v1/rollout/evaluate'));
    expect(response.status).toBe(200);
    assertSchema('/v1/rollout/evaluate', 'get', 200, response.body);
  });

  it('POST /v1/rollout/validation-gates (201) matches OpenAPI schema', async () => {
    const response = await withOperatorHeaders(
      request(app).post('/v1/rollout/validation-gates').send({
        suiteName: 'identity_rollout',
        machineId: 'machine-openapi',
        deviceId: '2603b760-7691-4327-95df-78ee53c2e3f8',
        accountId: '46903c28-9f99-495c-bf40-6f4d2ea8356b',
        orgId: '89c479b7-3f58-4957-a8aa-dba6bc4d0f65',
        generatedAtUtc: '2026-03-12T08:00:00.000Z',
        expiresAtUtc: '2026-03-13T08:00:00.000Z',
        passed: true,
        gates: [
          {
            gateId: 'stable_device_id',
            name: 'new install -> stable local device_id exists',
            success: true,
            detail: 'device_id is stable',
            checkedAtUtc: '2026-03-12T08:00:00.000Z'
          }
        ]
      })
    );

    expect(response.status).toBe(201);
    assertSchema('/v1/rollout/validation-gates', 'post', 201, response.body);
  });

  it('GET /v1/rollout/validation-gates matches OpenAPI schema', async () => {
    await withOperatorHeaders(
      request(app).post('/v1/rollout/validation-gates').send({
        suiteName: 'identity_rollout',
        machineId: 'machine-openapi',
        deviceId: '2603b760-7691-4327-95df-78ee53c2e3f8',
        accountId: '46903c28-9f99-495c-bf40-6f4d2ea8356b',
        orgId: '89c479b7-3f58-4957-a8aa-dba6bc4d0f65',
        generatedAtUtc: '2026-03-12T08:00:00.000Z',
        expiresAtUtc: '2026-03-13T08:00:00.000Z',
        passed: true,
        gates: [
          {
            gateId: 'stable_device_id',
            name: 'new install -> stable local device_id exists',
            success: true,
            detail: 'device_id is stable',
            checkedAtUtc: '2026-03-12T08:00:00.000Z'
          }
        ]
      })
    );

    const response = await withOperatorHeaders(request(app).get('/v1/rollout/validation-gates'));
    expect(response.status).toBe(200);
    assertSchema('/v1/rollout/validation-gates', 'get', 200, response.body);
  });

  it('GET /v1/rollout/evidence-pack matches OpenAPI schema', async () => {
    const response = await withOperatorHeaders(request(app).get('/v1/rollout/evidence-pack'));
    expect(response.status).toBe(200);
    assertSchema('/v1/rollout/evidence-pack', 'get', 200, response.body);
  });

  it('POST /v1/rollout/rollback (202) matches OpenAPI schema', async () => {
    runtimeState.rolloutState = 'PROMOTING';
    runtimeState.currentConfigSeq = 20;
    runtimeState.currentConfigVersion = '2026.02.20.20';
    runtimeState.previousConfigSeq = 19;
    runtimeState.previousConfigVersion = '2026.02.20.19';

    const response = await withOperatorHeaders(request(app).post('/v1/rollout/rollback'));
    expect(response.status).toBe(202);
    assertSchema('/v1/rollout/rollback', 'post', 202, response.body);
  });

  it('POST /v1/slo/evaluate matches OpenAPI schema', async () => {
    runtimeState.rolloutState = 'MONITORING';
    runtimeState.currentConfigSeq = 10;
    runtimeState.currentConfigVersion = '2026.02.20.10';
    runtimeState.previousConfigSeq = 9;
    runtimeState.previousConfigVersion = '2026.02.20.09';

    const response = await withOperatorHeaders(
      request(app).post('/v1/slo/evaluate').send({
        windowStartUtc: new Date(Date.now() - 30_000).toISOString(),
        windowEndUtc: new Date().toISOString(),
        cohortId: 'canary-1',
        errorRatePct: 1.2,
        p99LatencyMs: 420,
        degradationRatePct: 2.6,
        heartbeatGapIntervals: 3
      })
    );

    expect(response.status).toBe(200);
    assertSchema('/v1/slo/evaluate', 'post', 200, response.body);
  });

  it('GET /v1/config/diff-preview matches OpenAPI schema', async () => {
    const response = await withOperatorHeaders(request(app).get('/v1/config/diff-preview'));
    expect(response.status).toBe(200);
    assertSchema('/v1/config/diff-preview', 'get', 200, response.body);
  });

  it('GET /v1/config/integrity-active matches OpenAPI schema', async () => {
    const response = await withOperatorHeaders(request(app).get('/v1/config/integrity-active'));
    expect(response.status).toBe(200);
    assertSchema('/v1/config/integrity-active', 'get', 200, response.body);
  });

  it('GET /v1/nodes/snapshot matches OpenAPI schema', async () => {
    const response = await withOperatorHeaders(request(app).get('/v1/nodes/snapshot'));
    expect(response.status).toBe(200);
    assertSchema('/v1/nodes/snapshot', 'get', 200, response.body);
  });

  it('GET /v1/adapter/controls matches OpenAPI schema', async () => {
    const response = await withOperatorHeaders(request(app).get('/v1/adapter/controls'));
    expect(response.status).toBe(200);
    assertSchema('/v1/adapter/controls', 'get', 200, response.body);
  });

  it('GET /v1/growth/summary matches OpenAPI schema', async () => {
    await seedGrowthUserForContract('summary');

    const response = await withOperatorHeaders(request(app).get('/v1/growth/summary'));
    expect(response.status).toBe(200);
    assertSchema('/v1/growth/summary', 'get', 200, response.body);
  });

  it('GET /v1/growth/series matches OpenAPI schema', async () => {
    await seedGrowthUserForContract('series');

    const response = await withOperatorHeaders(
      request(app).get('/v1/growth/series').query({ metric: 'registrations', interval: 'day' })
    );
    expect(response.status).toBe(200);
    assertSchema('/v1/growth/series', 'get', 200, response.body);
  });

  it('GET /v1/growth/cohorts matches OpenAPI schema', async () => {
    await seedGrowthUserForContract('cohorts');

    const response = await withOperatorHeaders(request(app).get('/v1/growth/cohorts'));
    expect(response.status).toBe(200);
    assertSchema('/v1/growth/cohorts', 'get', 200, response.body);
  });

  it('GET /v1/growth/users/{accountId}/journey matches OpenAPI schema', async () => {
    const accountId = await seedGrowthUserForContract('journey');

    const response = await withOperatorHeaders(request(app).get(`/v1/growth/users/${accountId}/journey`));
    expect(response.status).toBe(200);
    assertSchema('/v1/growth/users/{accountId}/journey', 'get', 200, response.body);
  });

  it('POST /v1/adapter/controls (200) matches OpenAPI schema', async () => {
    process.env.CONTROL_PLANE_ADAPTER_EXPANSION_ENABLED = 'true';
    runtimeState.rolloutState = 'PROMOTING';

    const response = await withOperatorHeaders(
      request(app).post('/v1/adapter/controls').send({
        feature_adapter_enabled: true,
        allowed_cohorts: ['canary-1'],
        rate_limit: 100,
        circuit_breaker_threshold: 5,
        schema_version: '1.0.0'
      })
    );

    expect(response.status).toBe(200);
    assertSchema('/v1/adapter/controls', 'post', 200, response.body);
  });

  it('GET /v1/adapter/observability matches OpenAPI schema', async () => {
    const response = await withOperatorHeaders(request(app).get('/v1/adapter/observability'));
    expect(response.status).toBe(200);
    assertSchema('/v1/adapter/observability', 'get', 200, response.body);
  });

  it('GET /v1/adapter/replay-log matches OpenAPI schema', async () => {
    const response = await withOperatorHeaders(request(app).get('/v1/adapter/replay-log').query({ cohort: 'canary-1' }));
    expect(response.status).toBe(200);
    assertSchema('/v1/adapter/replay-log', 'get', 200, response.body);
  });

  it('GET /v1/adapter/promotion-path matches OpenAPI schema', async () => {
    const response = await withOperatorHeaders(request(app).get('/v1/adapter/promotion-path'));
    expect(response.status).toBe(200);
    assertSchema('/v1/adapter/promotion-path', 'get', 200, response.body);
  });

  it('POST /v1/adapter/promotion-path matches OpenAPI schema', async () => {
    const response = await withOperatorHeaders(request(app).post('/v1/adapter/promotion-path'));
    expect(response.status).toBe(200);
    assertSchema('/v1/adapter/promotion-path', 'post', 200, response.body);
  });

  it('GET /v1/audit/rollout-events matches OpenAPI schema', async () => {
    const response = await withAdminHeaders(request(app).get('/v1/audit/rollout-events'));
    expect(response.status).toBe(200);
    assertSchema('/v1/audit/rollout-events', 'get', 200, response.body);
  });

  it('GET /v1/audit/ledger-view matches OpenAPI schema