import { SLOMetrics } from '@porta/api-contracts';
import { appendOperatorAuditEvent } from './operatorAudit.js';

export interface SLOThresholds {
  errorRatePct: number;
  p99LatencyMs: number;
  degradationRatePct: number;
  heartbeatGapIntervals: number;
}

export interface SLOGateConfig {
  trigger: SLOThresholds;
  recovery: SLOThresholds;
  rollingWindowMs: number;
  recoveryHoldMs: number;
}

interface MetricSample {
  atMs: number;
  metrics: SLOMetrics;
}

interface GateState {
  tripped: boolean;
  healthySinceMs?: number;
}

export interface AggregatedSLO {
  windowStartUtc: string;
  windowEndUtc: string;
  cohortId: string;
  sampleCount: number;
  errorRatePct: number;
  p99LatencyMs: number;
  degradationRatePct: number;
  heartbeatGapIntervals: number;
}

export interface SLOGateDecision {
  breached: boolean;
  triggerAction: boolean;
  recovered: boolean;
  tripped: boolean;
  aggregated: AggregatedSLO;
}

const defaultConfig: SLOGateConfig = {
  trigger: {
    errorRatePct: 0.5,
    p99LatencyMs: 250,
    degradationRatePct: 1.0,
    heartbeatGapIntervals: 2
  },
  recovery: {
    errorRatePct: 0.3,
    p99LatencyMs: 200,
    degradationRatePct: 0.7,
    heartbeatGapIntervals: 1
  },
  rollingWindowMs: 5 * 60 * 1000,
  recoveryHoldMs: 10 * 60 * 1000
};

const samplesByCohort = new Map<string, MetricSample[]>();
const gateStateByCohort = new Map<string, GateState>();

function readConfig(): SLOGateConfig {
  const toNumber = (raw: string | undefined, fallback: number): number => {
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };

  return {
    trigger: {
      errorRatePct: toNumber(process.env.SLO_TRIGGER_ERROR_RATE_PCT, defaultConfig.trigger.errorRatePct),
      p99LatencyMs: toNumber(process.env.SLO_TRIGGER_P99_LATENCY_MS, defaultConfig.trigger.p99LatencyMs),
      degradationRatePct: toNumber(process.env.SLO_TRIGGER_DEGRADATION_RATE_PCT, defaultConfig.trigger.degradationRatePct),
      heartbeatGapIntervals: toNumber(process.env.SLO_TRIGGER_HEARTBEAT_GAP_INTERVALS, defaultConfig.trigger.heartbeatGapIntervals)
    },
    recovery: {
      errorRatePct: toNumber(process.env.SLO_RECOVERY_ERROR_RATE_PCT, defaultConfig.recovery.errorRatePct),
      p99LatencyMs: toNumber(process.env.SLO_RECOVERY_P99_LATENCY_MS, defaultConfig.recovery.p99LatencyMs),
      degradationRatePct: toNumber(process.env.SLO_RECOVERY_DEGRADATION_RATE_PCT, defaultConfig.recovery.degradationRatePct),
      heartbeatGapIntervals: toNumber(process.env.SLO_RECOVERY_HEARTBEAT_GAP_INTERVALS, defaultConfig.recovery.heartbeatGapIntervals)
    },
    rollingWindowMs: toNumber(process.env.SLO_ROLLING_WINDOW_MS, defaultConfig.rollingWindowMs),
    recoveryHoldMs: toNumber(process.env.SLO_RECOVERY_HOLD_MS, defaultConfig.recoveryHoldMs)
  };
}

function pruneOldSamples(samples: MetricSample[], nowMs: number, rollingWindowMs: number): MetricSample[] {
  const floor = nowMs - rollingWindowMs;
  return samples.filter((s) => s.atMs >= floor);
}

function aggregate(cohortId: string, samples: MetricSample[]): AggregatedSLO {
  const sampleCount = Math.max(1, samples.length);
  const sumError = samples.reduce((n, s) => n + s.metrics.errorRatePct, 0);
  const sumDeg = samples.reduce((n, s) => n + s.metrics.degradationRatePct, 0);
  const maxP99 = samples.reduce((n, s) => Math.max(n, s.metrics.p99LatencyMs), 0);
  const maxGap = samples.reduce((n, s) => Math.max(n, s.metrics.heartbeatGapIntervals), 0);
  const start = samples[0]?.metrics.windowStartUtc ?? new Date().toISOString();
  const end = samples[samples.length - 1]?.metrics.windowEndUtc ?? new Date().toISOString();

  return {
    windowStartUtc: start,
    windowEndUtc: end,
    cohortId,
    sampleCount,
    errorRatePct: sumError / sampleCount,
    p99LatencyMs: maxP99,
    degradationRatePct: sumDeg / sampleCount,
    heartbeatGapIntervals: maxGap
  };
}

function isOverThresholds(value: AggregatedSLO, thresholds: SLOThresholds): boolean {
  return (
    value.errorRatePct > thresholds.errorRatePct ||
    value.p99LatencyMs > thresholds.p99LatencyMs ||
    value.degradationRatePct > thresholds.degradationRatePct ||
    value.heartbeatGapIntervals > thresholds.heartbeatGapIntervals
  );
}

export function evaluateSLOGates(metrics: SLOMetrics, actorId = 'system', nowMs = Date.now()): SLOGateDecision {
  const config = readConfig();
  const cohortId = metrics.cohortId || 'unknown';
  const existingSamples = samplesByCohort.get(cohortId) ?? [];
  const nextSamples = pruneOldSamples([...existingSamples, { atMs: nowMs, metrics }], nowMs, config.rollingWindowMs);
  samplesByCohort.set(cohortId, nextSamples);

  const aggregated = aggregate(cohortId, nextSamples);
  const breached = isOverThresholds(aggregated, config.trigger);
  const recoveryHealthy = !isOverThresholds(aggregated, config.recovery);

  const previous = gateStateByCohort.get(cohortId) ?? { tripped: false };
  let triggerAction = false;
  let recovered = false;
  const nextState: GateState = { ...previous };

  if (breached) {
    if (!previous.tripped) {
      triggerAction = true;
      appendOperatorAuditEvent(actorId, 'slo.gate_tripped', 'slo_evaluator', {
        cohortId,
        errorRatePct: Number(aggregated.errorRatePct.toFixed(4)),
        p99LatencyMs: aggregated.p99LatencyMs,
        degradationRatePct: Number(aggregated.degradationRatePct.toFixed(4)),
        heartbeatGapIntervals: aggregated.heartbeatGapIntervals
      });
    }
    nextState.tripped = true;
    nextState.healthySinceMs = undefined;
  } else if (nextState.tripped) {
    if (recoveryHealthy) {
      if (!nextState.healthySinceMs) {
        nextState.healthySinceMs = nowMs;
      }
      if (nowMs - nextState.healthySinceMs >= config.recoveryHoldMs) {
        nextState.tripped = false;
        nextState.healthySinceMs = undefined;
        recovered = true;
        appendOperatorAuditEvent(actorId, 'slo.gate_rearmed', 'slo_evaluator', {
          cohortId,
          recoveryHoldMs: config.recoveryHoldMs
        });
      }
    } else {
      nextState.healthySinceMs = undefined;
    }
  }

  gateStateByCohort.set(cohortId, nextState);

  return {
    breached,
    triggerAction,
    recovered,
    tripped: nextState.tripped,
    aggregated
  };
}

export function resetSLOGateStateForTests(): void {
  samplesByCohort.clear();
  gateStateByCohort.clear();
}
