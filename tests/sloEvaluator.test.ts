import { beforeEach, describe, expect, it } from 'vitest';
import { SLOMetrics } from '@porta/api-contracts';
import { evaluateSLOGates, resetSLOGateStateForTests } from '../src/core/sloEvaluator.js';

function buildMetrics(
  cohortId: string,
  errorRatePct: number,
  p99LatencyMs: number,
  degradationRatePct: number,
  heartbeatGapIntervals: number,
  atMs: number
): SLOMetrics {
  return {
    cohortId,
    errorRatePct,
    p99LatencyMs,
    degradationRatePct,
    heartbeatGapIntervals,
    windowStartUtc: new Date(atMs - 1000).toISOString(),
    windowEndUtc: new Date(atMs).toISOString()
  };
}

describe('slo evaluator', () => {
  beforeEach(() => {
    resetSLOGateStateForTests();
    process.env.SLO_TRIGGER_ERROR_RATE_PCT = '0.5';
    process.env.SLO_TRIGGER_P99_LATENCY_MS = '250';
    process.env.SLO_TRIGGER_DEGRADATION_RATE_PCT = '1.0';
    process.env.SLO_TRIGGER_HEARTBEAT_GAP_INTERVALS = '2';
    process.env.SLO_RECOVERY_ERROR_RATE_PCT = '0.3';
    process.env.SLO_RECOVERY_P99_LATENCY_MS = '200';
    process.env.SLO_RECOVERY_DEGRADATION_RATE_PCT = '0.7';
    process.env.SLO_RECOVERY_HEARTBEAT_GAP_INTERVALS = '1';
    process.env.SLO_ROLLING_WINDOW_MS = '2000';
    process.env.SLO_RECOVERY_HOLD_MS = '5000';
  });

  it('trips only once while the cohort remains breached', () => {
    const now = Date.now();
    const m1 = buildMetrics('canary-1', 0.9, 260, 1.3, 3, now);
    const first = evaluateSLOGates(m1, 'system', now);
    expect(first.breached).toBe(true);
    expect(first.triggerAction).toBe(true);
    expect(first.tripped).toBe(true);

    const m2 = buildMetrics('canary-1', 1.1, 280, 1.5, 4, now + 1000);
    const again = evaluateSLOGates(m2, 'system', now + 1000);
    expect(again.breached).toBe(true);
    expect(again.triggerAction).toBe(false);
    expect(again.tripped).toBe(true);
  });

  it('rearms only after sustained healthy period', () => {
    const t0 = Date.now();
    evaluateSLOGates(buildMetrics('canary-5', 0.8, 255, 1.2, 3, t0), 'system', t0);

    const t1 = t0 + 1000;
    const healthyA = evaluateSLOGates(buildMetrics('canary-5', 0.1, 120, 0.2, 0, t1), 'system', t1);
    expect(healthyA.recovered).toBe(false);
    expect(healthyA.tripped).toBe(true);

    const t2 = t1 + 5200;
    const healthyB = evaluateSLOGates(buildMetrics('canary-5', 0.1, 110, 0.2, 0, t2), 'system', t2);
    expect(healthyB.recovered).toBe(false);
    expect(healthyB.tripped).toBe(true);
    expect(healthyB.breached).toBe(false);

    const t3 = t2 + 5200;
    const healthyC = evaluateSLOGates(buildMetrics('canary-5', 0.1, 110, 0.2, 0, t3), 'system', t3);
    expect(healthyC.recovered).toBe(true);
    expect(healthyC.tripped).toBe(false);
    expect(healthyC.breached).toBe(false);
  });
});
