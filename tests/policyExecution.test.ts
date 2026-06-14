import * as fs from 'node:fs';
import * as path from 'node:path';
import * as supertest from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const request = (
  (supertest as unknown as { default?: unknown }).default ?? supertest
) as typeof import('supertest');
const app = createApp();
const dataDir = path.resolve('.data');

const TEST_OPERATOR_KEY = 'test-operator-key-policy';

function withHeaders(req: supertest.Test, role: 'operator' | 'admin' | 'auditor'): supertest.Test {
  return req
    .set('x-operator-id', `${role}-user`)
    .set('x-operator-role', role)
    .set('x-operator-key', TEST_OPERATOR_KEY);
}

describe('policy execution and governance', () => {
  beforeEach(() => {
    process.env.PORTA_OPERATOR_KEY = TEST_OPERATOR_KEY;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('evaluates policies in deterministic priority order and emits signed commands', async () => {
    const response = await withHeaders(
      request(app).post('/v1/policy/evaluate').send({
        environment: 'prod',
        metrics: [
          {
            schema_name: 'control.telemetry.metric',
            metric_name: 'cpu_usage_percent',
            aggregation: 'p95',
            window_seconds: 60,
            value: 89
          },
          {
            schema_name: 'control.telemetry.metric',
            metric_name: 'memory_usage_percent',
            aggregation: 'avg',
            window_seconds: 300,
            value: 95
          },
          {
            schema_name: 'control.telemetry.metric',
            metric_name: 'http_latency_ms',
            aggregation: 'p99',
            window_seconds: 120,
            value: 820
          }
        ],
        timestamp: '2026-02-22T15:12:30Z',
        kill_switch_enabled: true
      }),
      'operator'
    );

    expect(response.status).toBe(200);
    expect(response.body.triggered_policy_ids_in_order).toEqual([
      '018f9b76-a2de-7023-bbb3-6a51a911e2d0',
      '018f9b74-ff6a-7b10-baa1-6f4e77a2d901',
      '018f9b75-43c2-7e30-91fa-924ae9ab4c33'
    ]);
    expect(response.body.signed_commands.length).toBe(3);
    expect(response.body.signed_commands[0].signature.algorithm).toBe('Ed25519');
  });

  it('enforces RBAC for decision trace access and supports replay verification', async () => {
    await withHeaders(
      request(app).post('/v1/policy/evaluate').send({
        environment: 'prod',
        metrics: [
          {
            schema_name: 'control.telemetry.metric',
            metric_name: 'cpu_usage_percent',
            aggregation: 'p95',
            window_seconds: 60,
            value: 89
          }
        ],
        timestamp: '2026-02-22T15:15:01Z',
        kill_switch_enabled: true
      }),
      'operator'
    );

    const denied = await withHeaders(request(app).get('/v1/audit/decision-traces'), 'operator');
    expect(denied.status).toBe(403);
    expect(denied.body.error_code).toBe('RBAC_DENIED');

    const allowed = await withHeaders(request(app).get('/v1/audit/decision-traces'), 'auditor');
    expect(allowed.status).toBe(200);
    expect(Array.isArray(allowed.body)).toBe(true);
    expect(allowed.body.length).toBeGreaterThan(0);

    const traceId = allowed.body[0].trace_id as string;
    const replay = await withHeaders(request(app).post('/v1/audit/replay/verify').send({ trace_id: traceId }), 'auditor');
    expect(replay.status).toBe(200);
    expect(['match', 'mismatch']).toContain(replay.body.result);
    expect(['verified', 'invalid']).toContain(replay.body.signature_verification);
  });
});

