import { setTimeout as delay } from 'node:timers/promises';

const baseUrl = process.env.CONTROL_PLANE_BASE_URL ?? 'http://localhost:3000';
const rounds = Number(process.env.STEP16_ROUNDS ?? 200);
const headers = {
  'content-type': 'application/json',
  'x-operator-id': process.env.STEP16_OPERATOR_ID ?? 'step16-load',
  'x-operator-role': process.env.STEP16_OPERATOR_ROLE ?? 'operator'
};

function buildPayload(i) {
  return {
    environment: 'prod',
    service: i % 2 === 0 ? 'payments-api' : 'checkout-api',
    correlation_id: `step16-load-${i}`,
    metrics: [
      {
        schema_name: 'control.telemetry.metric',
        metric_name: i % 2 === 0 ? 'cpu_usage_percent' : 'http_latency_ms',
        aggregation: i % 2 === 0 ? 'p95' : 'p99',
        window_seconds: i % 2 === 0 ? 60 : 120,
        value: i % 2 === 0 ? 86 + (i % 5) : 760 + (i % 20)
      },
      {
        schema_name: 'control.telemetry.metric',
        metric_name: 'stress_likelihood',
        aggregation: 'avg',
        window_seconds: 30,
        value: 0.91
      },
      {
        schema_name: 'control.telemetry.metric',
        metric_name: 'event_to_console_ms',
        aggregation: 'max',
        window_seconds: 30,
        value: 2300
      }
    ]
  };
}

let ok = 0;
let failed = 0;
const start = Date.now();
for (let i = 0; i < rounds; i += 1) {
  const res = await fetch(`${baseUrl}/v1/policy/evaluate`, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildPayload(i))
  });
  if (res.ok) {
    ok += 1;
  } else {
    failed += 1;
  }
  await delay(10);
}

const elapsedMs = Date.now() - start;
console.log(JSON.stringify({ rounds, ok, failed, elapsedMs, avgMsPerRequest: elapsedMs / Math.max(1, rounds) }, null, 2));
