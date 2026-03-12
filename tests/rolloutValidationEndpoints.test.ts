import * as fs from 'node:fs';
import * as path from 'node:path';
import * as supertest from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetSLOGateStateForTests } from '../src/core/sloEvaluator.js';
import { loadRuntimeState, resetRuntimeStateForTests } from '../src/store/runtimeState.js';

const dataDir = path.resolve('.data');
const request = (supertest as unknown as { default: typeof supertest }).default as unknown as typeof import('supertest');
const app = createApp();

function withOperatorHeaders(req: supertest.Test): supertest.Test {
  return req.set('x-operator-id', 'operator-validation').set('x-operator-role', 'operator');
}

function buildValidationReport(success: boolean): {
  suiteName: string;
  machineId: string;
  deviceId: string;
  accountId: string;
  orgId: string;
  generatedAtUtc: string;
  expiresAtUtc: string;
  passed: boolean;
  gates: Array<{
    gateId: string;
    name: string;
    success: boolean;
    detail: string;
    checkedAtUtc: string;
  }>;
} {
  return {
    suiteName: 'identity_rollout',
    machineId: 'machine-identity',
    deviceId: '2603b760-7691-4327-95df-78ee53c2e3f8',
    accountId: '46903c28-9f99-495c-bf40-6f4d2ea8356b',
    orgId: '89c479b7-3f58-4957-a8aa-dba6bc4d0f65',
    generatedAtUtc: '2026-03-12T08:00:00.000Z',
    expiresAtUtc: '2026-03-13T08:00:00.000Z',
    passed: success,
    gates: [
      {
        gateId: 'stable_device_id',
        name: 'new install -> stable local device_id exists',
        success,
        detail: success ? 'device_id is stable' : 'device_id could not be confirmed',
        checkedAtUtc: '2026-03-12T08:00:00.000Z'
      }
    ]
  };
}

describe('rollout validation endpoints', () => {
  beforeEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    resetRuntimeStateForTests();
    resetSLOGateStateForTests();
    loadRuntimeState();
  });

  it('stores and returns rollout validation reports', async () => {
    const empty = await withOperatorHeaders(request(app).get('/v1/rollout/validation-gates'));
    expect(empty.status).toBe(404);
    expect(empty.body.error_code).toBe('VALIDATION_REPORT_NOT_FOUND');

    const response = await withOperatorHeaders(request(app).post('/v1/rollout/validation-gates').send(buildValidationReport(true)));
    expect(response.status).toBe(201);
    expect(response.body.suiteName).toBe('identity_rollout');
    expect(response.body.passed).toBe(true);
    expect(response.body.gates).toHaveLength(1);

    const readBack = await withOperatorHeaders(request(app).get('/v1/rollout/validation-gates'));
    expect(readBack.status).toBe(200);
    expect(readBack.body.machineId).toBe('machine-identity');
    expect(readBack.body.updatedAtUtc).toBeTruthy();
    expect(readBack.body.gates[0]?.gateId).toBe('stable_device_id');
  });

  it('surfaces rollout validation failures through rollout evaluation', async () => {
    const publish = await withOperatorHeaders(request(app).post('/v1/rollout/validation-gates').send(buildValidationReport(false)));
    expect(publish.status).toBe(201);
    expect(publish.body.passed).toBe(false);

    const evaluation = await withOperatorHeaders(request(app).get('/v1/rollout/evaluate'));
    expect(evaluation.status).toBe(200);

    const validationGuardrail = evaluation.body.guardrail_eval.find(
      (entry: { guardrail_id?: string; }) => entry.guardrail_id === 'VALIDATION_GATES'
    );
    expect(validationGuardrail).toBeTruthy();
    expect(validationGuardrail.status).toBe('FAIL');
    expect(validationGuardrail.reason_code).toBe('VALIDATION_GATES_FAILED');
    expect(evaluation.body.decision.trigger_reason_code).not.toBe('ALL_GUARDRAILS_PASS');
  });
});
