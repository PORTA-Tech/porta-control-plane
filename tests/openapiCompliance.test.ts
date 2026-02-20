import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import SwaggerParser from '@apidevtools/swagger-parser';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetSLOGateStateForTests } from '../src/core/sloEvaluator.js';
import { loadRuntimeState, resetRuntimeStateForTests, runtimeState } from '../src/store/runtimeState.js';

const dataDir = path.resolve('.data');
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

function withOperatorHeaders(req: request.Test): request.Test {
  return req.set('x-operator-id', 'operator-openapi').set('x-operator-role', 'operator');
}

function withAdminHeaders(req: request.Test): request.Test {
  return req.set('x-operator-id', 'admin-openapi').set('x-operator-role', 'admin');
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
    const openapiPath = path.resolve('node_modules', '@porta', 'api-contracts', 'src', 'openapi', 'control-plane.yaml');
    openApi = (await SwaggerParser.dereference(openapiPath)) as OpenApiDoc;
  });

  beforeEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    resetRuntimeStateForTests();
    resetSLOGateStateForTests();
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

  it('GET /v1/audit/rollout-events matches OpenAPI schema', async () => {
    const response = await withAdminHeaders(request(app).get('/v1/audit/rollout-events'));
    expect(response.status).toBe(200);
    assertSchema('/v1/audit/rollout-events', 'get', 200, response.body);
  });
});
