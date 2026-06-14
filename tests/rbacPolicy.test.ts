import * as fs from 'node:fs';
import * as path from 'node:path';
import * as supertest from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetSLOGateStateForTests } from '../src/core/sloEvaluator.js';
import { loadRuntimeState, resetRuntimeStateForTests } from '../src/store/runtimeState.js';

const dataDir = path.resolve('.data');
const request = (
  (supertest as unknown as { default?: unknown }).default ?? supertest
) as typeof import('supertest');
const app = createApp();

const TEST_OPERATOR_KEY = 'test-operator-key-rbac';

function withHeaders(req: supertest.Test, role: 'viewer' | 'operator' | 'admin'): supertest.Test {
  return req
    .set('x-operator-id', `${role}-user`)
    .set('x-operator-role', role)
    .set('x-operator-key', TEST_OPERATOR_KEY);
}

describe('rbac policy', () => {
  beforeEach(() => {
    process.env.PORTA_OPERATOR_KEY = TEST_OPERATOR_KEY;
    fs.rmSync(dataDir, { recursive: true, force: true });
    resetRuntimeStateForTests();
    resetSLOGateStateForTests();
    loadRuntimeState();
  });

  it('allows /health without operator headers', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it('rejects /v1 routes without auth headers', async () => {
    const response = await request(app).get('/v1/rollout/state');
    expect(response.status).toBe(401);
  });

  it('allows viewer to read rollout state but blocks rollback', async () => {
    const read = await withHeaders(request(app).get('/v1/rollout/state'), 'viewer');
    expect(read.status).toBe(200);

    const dryRun = await withHeaders(request(app).get('/v1/rollout/dry-run'), 'viewer');
    expect(dryRun.status).toBe(200);

    const evaluate = await withHeaders(request(app).get('/v1/rollout/evaluate'), 'viewer');
    expect(evaluate.status).toBe(200);

    const validationRead = await withHeaders(request(app).get('/v1/rollout/validation-gates'), 'viewer');
    expect(validationRead.status).toBe(404);

    const evidencePack = await withHeaders(request(app).get('/v1/rollout/evidence-pack'), 'viewer');
    expect(evidencePack.status).toBe(200);

    const configDiff = await withHeaders(request(app).get('/v1/config/diff-preview'), 'viewer');
    expect(configDiff.status).toBe(200);

    const configIntegrity = await withHeaders(request(app).get('/v1/config/integrity-active'), 'viewer');
    expect(configIntegrity.status).toBe(200);

    const nodeSnapshotRead = await withHeaders(request(app).get('/v1/nodes/snapshot'), 'viewer');
    expect(nodeSnapshotRead.status).toBe(200);

    const adapterControlsRead = await withHeaders(request(app).get('/v1/adapter/controls'), 'viewer');
    expect(adapterControlsRead.status).toBe(200);

    const adapterObservabilityRead = await withHeaders(request(app).get('/v1/adapter/observability'), 'viewer');
    expect(adapterObservabilityRead.status).toBe(200);

    const adapterReplayRead = await withHeaders(request(app).get('/v1/adapter/replay-log').query({ cohort: 'canary-1' }), 'viewer');
    expect(adapterReplayRead.status).toBe(200);

    const adapterPromotionRead = await withHeaders(request(app).get('/v1/adapter/promotion-path'), 'viewer');
    expect(adapterPromotionRead.status).toBe(200);

    const growthSummaryRead = await withHeaders(request(app).get('/v1/growth/summary'), 'viewer');
    expect(growthSummaryRead.status).toBe(200);

    const growthSeriesRead = await withHeaders(
      request(app).get('/v1/growth/series').query({ metric: 'registrations', interval: 'day' }),
      'viewer'
    );
    expect(growthSeriesRead.status).toBe(200);

    const growthCohortsRead = await withHeaders(request(app).get('/v1/growth/cohorts'), 'viewer');
    expect(growthCohortsRead.status).toBe(200);

    const growthJourneyRead = await withHeaders(
      request(app).get('/v1/growth/users/00000000-0000-0000-0000-000000000000/journey'),
      'viewer'
    );
    expect(growthJourneyRead.status).toBe(404);

    const write = await withHeaders(request(app).post('/v1/rollout/rollback'), 'viewer');
    expect(write.status).toBe(403);

    const validationWrite = await withHeaders(request(app).post('/v1/rollout/validation-gates').send({
      suiteName: 'identity_rollout',
      machineId: 'machine-rbac',
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
    }), 'viewer');
    expect(validationWrite.status).toBe(403);

    const adapterControlsWrite = await withHeaders(request(app).post('/v1/adapter/controls').send({
      feature_adapter_enabled: false,
      allowed_cohorts: ['canary-1'],
      rate_limit: 100,
      circuit_breaker_threshold: 5,
      schema_version: '1.0.0'
    }), 'viewer');
    expect(adapterControlsWrite.status).toBe(403);

    const adapterPromotionWrite = await withHeaders(request(app).post('/v1/adapter/promotion-path'), 'viewer');
    expect(adapterPromotionWrite.status).toBe(403);
  });

  it('allows operator to execute rollback', async () => {
    const response = await withHeaders(request(app).post('/v1/rollout/rollback'), 'operator');
    expect(response.status).toBe(202);
    expect(response.body.state).toBe('COOLDOWN');
  });

  it('allows operator to publish rollout validation gates', async () => {
    const response = await withHeaders(request(app).post('/v1/rollout/validation-gates').send({
      suiteName: 'identity_rollout',
      machineId: 'machine-rbac',
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
    }), 'operator');

    expect(response.status).toBe(201);
    expect(response.body.passed).toBe(true);
  });

  it('blocks admin from rollout write actions by policy', async () => {
    const response = await withHeaders(request(app).post('/v1/rollout/rollback'), 'admin');
    expect(response.status).toBe(403);
  });

  it('allows only admin to query audit endpoints', async () => {
    const operatorResponse = await withHeaders(request(app).get('/v1/audit/events'), 'operator');
    expect(operatorResponse.status).toBe(403);

    const adminResponse = await withHeaders(request(app).get('/v1/audit/events'), 'admin');
    expect(adminResponse.status).toBe(200);

    const operatorLedgerResponse = await withHeaders(request(app).get('/v1/audit/ledger-view'), 'operator');
    expect(operatorLedgerResponse.status).toBe(403);

    const adminLedgerResponse = await withHeaders(request(app).get('/v1/audit/ledger-view'), 'admin');
    expect(adminLedgerResponse.status).toBe(200);
  });

  it('allows only admin to query and dispatch outbox endpoints', async () => {
    const operatorStatus = await withHeaders(request(app).get('/v1/audit/outbox/status'), 'operator');
    expect(operatorStatus.status).toBe(403);

    const adminStatus = await withHeaders(request(app).get('/v1/audit/outbox/status'), 'admin');
    expect(adminStatus.status).toBe(200);

    const operatorDispatch = await withHeaders(request(app).post('/v1/audit/outbox/dispatch'), 'operator');
    expect(operatorDispatch.status).toBe(403);

    const adminDispatch = await withHeaders(request(app).post('/v1/audit/outbox/dispatch'), 'admin');
    expect(adminDispatch.status).toBe(200);
  });
});
