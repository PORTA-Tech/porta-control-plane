import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetSLOGateStateForTests } from '../src/core/sloEvaluator.js';
import { loadRuntimeState, resetRuntimeStateForTests, runtimeState } from '../src/store/runtimeState.js';

const dataDir = path.resolve('.data');
const app = createApp();

function withOperatorHeaders(req: request.Test): request.Test {
  return req.set('x-operator-id', 'operator-int').set('x-operator-role', 'operator');
}

describe('endpoint integration', () => {
  beforeEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    resetRuntimeStateForTests();
    resetSLOGateStateForTests();
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
});
