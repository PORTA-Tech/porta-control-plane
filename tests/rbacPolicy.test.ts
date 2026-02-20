import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetSLOGateStateForTests } from '../src/core/sloEvaluator.js';
import { loadRuntimeState, resetRuntimeStateForTests } from '../src/store/runtimeState.js';

const dataDir = path.resolve('.data');
const app = createApp();

function withHeaders(req: request.Test, role: 'viewer' | 'operator' | 'admin'): request.Test {
  return req.set('x-operator-id', `${role}-user`).set('x-operator-role', role);
}

describe('rbac policy', () => {
  beforeEach(() => {
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

    const write = await withHeaders(request(app).post('/v1/rollout/rollback'), 'viewer');
    expect(write.status).toBe(403);
  });

  it('allows operator to execute rollback', async () => {
    const response = await withHeaders(request(app).post('/v1/rollout/rollback'), 'operator');
    expect(response.status).toBe(202);
    expect(response.body.state).toBe('COOLDOWN');
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
  });
});
