import * as fs from 'node:fs';
import * as path from 'node:path';
import * as supertest from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetSLOGateStateForTests } from '../src/core/sloEvaluator.js';
import { loadRuntimeState, resetRuntimeStateForTests, runtimeState } from '../src/store/runtimeState.js';
import { appendLedgerRecord } from '../src/core/auditLedger.js';

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
    fs.rmSync(dataDir, { recursive: true, force: true });
    resetRuntimeStateForTests();
    resetSLOGateStateForTests();
    delete process.env.CONTROL_PLANE_ADAPTER_EXPANSION_ENABLED;
    loadRuntimeState();
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
