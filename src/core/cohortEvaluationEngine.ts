import crypto from 'node:crypto';
import { listAgentPresence } from '../store/agentPresenceStore.js';
import { appendOperatorAuditEvent } from './operatorAudit.js';

export type CohortId = 'stable' | 'canary-1' | 'canary-5' | 'internal' | 'experimental';
export type CohortWindow = '15m' | '1h' | '6h' | '24h';
export type CohortRegressionMetric = 'error_rate' | 'p99_latency' | 'degradation_rate';
export type CohortRegressionSeverity = 'warning' | 'critical';
export type CohortConfidence = 'low' | 'medium' | 'high';

interface CohortAggregateInternal {
  cohortId: CohortId;
  machineCount: number;
  degradedCount: number;
  staleCount: number;
  invalidSignatureCount: number;
  configDistribution: Record<string, number>;
}

interface CohortMetricSample {
  atMs: number;
  errorRatePct: number;
  p99LatencyMs: number;
  degradationRatePct: number;
}

interface CohortEventInternal {
  eventId: string;
  correlationId: string;
  type: 'COHORT_REGRESSION';
  cohortId: CohortId;
  baselineCohortId: CohortId;
  metric: CohortRegressionMetric;
  delta: number;
  threshold: number;
  severity: CohortRegressionSeverity;
  confidence: CohortConfidence;
  machineCount: number;
  window: CohortWindow;
  triggeredAt: string;
  lastSeenAt: string;
  state: 'active' | 'resolved';
  reason: string;
  resolvedAt?: string;
}

export interface CohortTrendPointView {
  timestamp_utc: string;
  error_rate_pct: number;
  p99_latency_ms: number;
  degradation_rate_pct: number;
}

export interface CohortEvaluationRowView {
  cohort_id: CohortId;
  machine_count: number;
  error_rate_pct: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  p99_latency_ms: number;
  degradation_rate_pct: number;
  config_distribution: Record<string, number>;
  delta_error_rate_pct: number;
  delta_p99_latency_ms: number;
  delta_degradation_rate_pct: number;
  confidence: CohortConfidence;
  trend: CohortTrendPointView[];
  active_event_count: number;
}

export interface CohortRegressionEventView {
  event_id: string;
  correlation_id: string;
  type: 'COHORT_REGRESSION';
  cohort_id: CohortId;
  baseline_cohort_id: CohortId;
  metric: CohortRegressionMetric;
  delta: number;
  threshold: number;
  severity: CohortRegressionSeverity;
  confidence: CohortConfidence;
  machine_count: number;
  window: CohortWindow;
  triggered_at: string;
  last_seen_at: string;
  state: 'active' | 'resolved';
  reason: string;
  resolved_at?: string;
}

export interface CohortThresholdsView {
  p99_latency_delta_ms: number;
  error_rate_delta_pct: number;
  degradation_rate_delta_pct: number;
}

export interface CohortEvaluationView {
  generated_at: string;
  source: 'cohort_evaluation_engine';
  baseline_cohort_id: CohortId;
  window: CohortWindow;
  thresholds: CohortThresholdsView;
  rows: CohortEvaluationRowView[];
  active_events: CohortRegressionEventView[];
  recent_events: CohortRegressionEventView[];
}

const COHORT_ORDER: CohortId[] = ['stable', 'canary-1', 'canary-5', 'internal', 'experimental'];
const DEFAULT_BASELINE: CohortId = 'stable';
const DEFAULT_STALE_HEARTBEAT_SECONDS = 30;

const defaultBaseLatencyByCohort: Record<CohortId, number> = {
  stable: 46,
  'canary-1': 54,
  'canary-5': 57,
  internal: 42,
  experimental: 62
};

const trendHistoryByCohort = new Map<CohortId, CohortMetricSample[]>();
const activeEventsByKey = new Map<string, CohortEventInternal>();
const recentEvents: CohortEventInternal[] = [];

function parseNonNegativeNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readStaleHeartbeatSeconds(): number {
  return parseNonNegativeNumber(process.env.NODE_STALE_HEARTBEAT_SECONDS, DEFAULT_STALE_HEARTBEAT_SECONDS);
}

function readThresholds(): CohortThresholdsView {
  return {
    p99_latency_delta_ms: parseNonNegativeNumber(process.env.COHORT_TRIGGER_DELTA_P99_MS, 20),
    error_rate_delta_pct: parseNonNegativeNumber(process.env.COHORT_TRIGGER_DELTA_ERROR_RATE_PCT, 0.5),
    degradation_rate_delta_pct: parseNonNegativeNumber(process.env.COHORT_TRIGGER_DELTA_DEGRADATION_PCT, 1.0)
  };
}

function round(value: number, decimals = 3): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function confidenceForMachineCount(machineCount: number): CohortConfidence {
  if (machineCount > 100) return 'high';
  if (machineCount >= 20) return 'medium';
  return 'low';
}

function severityForDelta(delta: number, threshold: number): CohortRegressionSeverity {
  if (threshold <= 0) {
    return 'warning';
  }
  return delta / threshold >= 2 ? 'critical' : 'warning';
}

function metricLabel(metric: CohortRegressionMetric): string {
  if (metric === 'p99_latency') return 'Delta P99 Latency';
  if (metric === 'error_rate') return 'Delta Error Rate';
  return 'Delta Degradation';
}

function formatThreshold(metric: CohortRegressionMetric, value: number): string {
  if (metric === 'p99_latency') {
    return `+${Math.round(value)}ms`;
  }
  return `+${round(value, 3)}%`;
}

function formatDelta(metric: CohortRegressionMetric, delta: number): string {
  if (metric === 'p99_latency') {
    return `${delta >= 0 ? '+' : ''}${Math.round(delta)}ms`;
  }
  return `${delta >= 0 ? '+' : ''}${round(delta, 3)}%`;
}

function parseWindow(window: string | undefined): CohortWindow {
  if (window === '15m' || window === '1h' || window === '6h' || window === '24h') {
    return window;
  }
  return '1h';
}

function parseBaseline(value: string | undefined): CohortId {
  if (value && COHORT_ORDER.includes(value as CohortId)) {
    return value as CohortId;
  }
  return DEFAULT_BASELINE;
}

function cohortForAgentId(agentId: string): CohortId {
  const hash = Array.from(agentId).reduce((acc, ch) => ((acc * 33) ^ ch.charCodeAt(0)) >>> 0, 5381);
  const bucket = hash % 100;
  if (bucket < 90) return 'stable';
  if (bucket < 91) return 'canary-1';
  if (bucket < 96) return 'canary-5';
  if (bucket < 98) return 'internal';
  return 'experimental';
}

function windowConfig(window: CohortWindow): { windowMs: number; bucketMs: number; points: number } {
  if (window === '15m') return { windowMs: 15 * 60_000, bucketMs: 2.5 * 60_000, points: 6 };
  if (window === '1h') return { windowMs: 60 * 60_000, bucketMs: 5 * 60_000, points: 12 };
  if (window === '6h') return { windowMs: 6 * 60 * 60_000, bucketMs: 30 * 60_000, points: 12 };
  return { windowMs: 24 * 60 * 60_000, bucketMs: 60 * 60_000, points: 24 };
}

function eventKey(
  cohortId: CohortId,
  baselineCohortId: CohortId,
  metric: CohortRegressionMetric,
  window: CohortWindow
): string {
  return `${cohortId}|${baselineCohortId}|${metric}|${window}`;
}

function toEventView(event: CohortEventInternal): CohortRegressionEventView {
  return {
    event_id: event.eventId,
    correlation_id: event.correlationId,
    type: event.type,
    cohort_id: event.cohortId,
    baseline_cohort_id: event.baselineCohortId,
    metric: event.metric,
    delta: event.delta,
    threshold: event.threshold,
    severity: event.severity,
    confidence: event.confidence,
    machine_count: event.machineCount,
    window: event.window,
    triggered_at: event.triggeredAt,
    last_seen_at: event.lastSeenAt,
    state: event.state,
    reason: event.reason,
    ...(event.resolvedAt ? { resolved_at: event.resolvedAt } : {})
  };
}

function aggregateCurrentRows(nowMs: number): CohortEvaluationRowView[] {
  const staleThresholdMs = readStaleHeartbeatSeconds() * 1000;
  const groups = new Map<CohortId, CohortAggregateInternal>();

  for (const cohortId of COHORT_ORDER) {
    groups.set(cohortId, {
      cohortId,
      machineCount: 0,
      degradedCount: 0,
      staleCount: 0,
      invalidSignatureCount: 0,
      configDistribution: {}
    });
  }

  for (const presence of listAgentPresence()) {
    const cohortId = cohortForAgentId(presence.agentId);
    const group = groups.get(cohortId);
    if (!group) {
      continue;
    }

    group.machineCount += 1;
    const parsedHeartbeat = Date.parse(presence.lastHeartbeatUtc);
    const stale = Number.isFinite(parsedHeartbeat) ? nowMs - parsedHeartbeat > staleThresholdMs : true;
    const invalidSignature = !presence.signatureValidity;
    const degraded = stale || invalidSignature;

    if (stale) {
      group.staleCount += 1;
    }
    if (invalidSignature) {
      group.invalidSignatureCount += 1;
    }
    if (degraded) {
      group.degradedCount += 1;
    }

    const configKey = String(presence.configSeq);
    group.configDistribution[configKey] = (group.configDistribution[configKey] ?? 0) + 1;
  }

  return COHORT_ORDER.map((cohortId) => {
    const group = groups.get(cohortId)!;
    const machineCount = group.machineCount;

    const degradedRatio = machineCount > 0 ? group.degradedCount / machineCount : 0;
    const staleRatio = machineCount > 0 ? group.staleCount / machineCount : 0;
    const invalidSignatureRatio = machineCount > 0 ? group.invalidSignatureCount / machineCount : 0;

    const errorRatePct = round((degradedRatio * 0.8) + (staleRatio * 0.2), 3);
    const degradationRatePct = round(degradedRatio * 2.0, 3);

    const p99Base = defaultBaseLatencyByCohort[cohortId];
    const p99LatencyMs = machineCount > 0
      ? Math.max(
          1,
          Math.round(
            p99Base
              + (degradedRatio * 120)
              + (staleRatio * 180)
              + (invalidSignatureRatio * 90)
          )
        )
      : 0;
    const p95LatencyMs = p99LatencyMs > 0 ? Math.max(1, Math.round(p99LatencyMs * 0.72)) : 0;
    const p50LatencyMs = p99LatencyMs > 0 ? Math.max(1, Math.round(p99LatencyMs * 0.41)) : 0;

    return {
      cohort_id: cohortId,
      machine_count: machineCount,
      error_rate_pct: errorRatePct,
      p50_latency_ms: p50LatencyMs,
      p95_latency_ms: p95LatencyMs,
      p99_latency_ms: p99LatencyMs,
      degradation_rate_pct: degradationRatePct,
      config_distribution: group.configDistribution,
      delta_error_rate_pct: 0,
      delta_p99_latency_ms: 0,
      delta_degradation_rate_pct: 0,
      confidence: confidenceForMachineCount(machineCount),
      trend: [],
      active_event_count: 0
    };
  });
}

function appendTrendSamples(rows: CohortEvaluationRowView[], nowMs: number): void {
  const floorMs = nowMs - (24 * 60 * 60_000);
  for (const row of rows) {
    const samples = trendHistoryByCohort.get(row.cohort_id) ?? [];
    samples.push({
      atMs: nowMs,
      errorRatePct: row.error_rate_pct,
      p99LatencyMs: row.p99_latency_ms,
      degradationRatePct: row.degradation_rate_pct
    });
    const trimmed = samples.filter((sample) => sample.atMs >= floorMs);
    trendHistoryByCohort.set(row.cohort_id, trimmed);
  }
}

function buildTrendForWindow(cohortId: CohortId, window: CohortWindow, nowMs: number): CohortTrendPointView[] {
  const config = windowConfig(window);
  const floorMs = nowMs - config.windowMs;
  const samples = (trendHistoryByCohort.get(cohortId) ?? []).filter((sample) => sample.atMs >= floorMs);

  const points: CohortTrendPointView[] = [];
  let carryError = 0;
  let carryP99 = 0;
  let carryDegradation = 0;

  for (let index = 0; index < config.points; index += 1) {
    const bucketStart = floorMs + (index * config.bucketMs);
    const bucketEnd = bucketStart + config.bucketMs;
    const bucketSamples = samples.filter((sample) => sample.atMs >= bucketStart && sample.atMs < bucketEnd);

    if (bucketSamples.length > 0) {
      const avgError = bucketSamples.reduce((sum, sample) => sum + sample.errorRatePct, 0) / bucketSamples.length;
      const maxP99 = bucketSamples.reduce((max, sample) => Math.max(max, sample.p99LatencyMs), 0);
      const avgDegradation = bucketSamples.reduce((sum, sample) => sum + sample.degradationRatePct, 0) / bucketSamples.length;
      carryError = avgError;
      carryP99 = maxP99;
      carryDegradation = avgDegradation;
    }

    points.push({
      timestamp_utc: new Date(Math.min(bucketEnd, nowMs)).toISOString(),
      error_rate_pct: round(carryError, 3),
      p99_latency_ms: Math.max(0, Math.round(carryP99)),
      degradation_rate_pct: round(carryDegradation, 3)
    });
  }

  return points;
}

function upsertActiveEvent(
  actorId: string,
  nowIso: string,
  row: CohortEvaluationRowView,
  baselineCohortId: CohortId,
  metric: CohortRegressionMetric,
  delta: number,
  threshold: number,
  window: CohortWindow
): CohortEventInternal {
  const key = eventKey(row.cohort_id, baselineCohortId, metric, window);
  const existing = activeEventsByKey.get(key);
  const severity = severityForDelta(delta, threshold);
  const reason = `${metricLabel(metric)} ${formatDelta(metric, delta)} exceeded ${formatThreshold(metric, threshold)} vs baseline ${baselineCohortId}.`;

  if (existing) {
    const updatedBase: CohortEventInternal = {
      ...existing,
      delta: round(delta, metric === 'p99_latency' ? 0 : 3),
      threshold: round(threshold, metric === 'p99_latency' ? 0 : 3),
      severity,
      confidence: row.confidence,
      machineCount: row.machine_count,
      lastSeenAt: nowIso,
      reason,
      state: 'active'
    };
    const { resolvedAt: _ignoredResolvedAt, ...updated } = updatedBase;
    activeEventsByKey.set(key, updated);
    return updated;
  }

  const created: CohortEventInternal = {
    eventId: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    type: 'COHORT_REGRESSION',
    cohortId: row.cohort_id,
    baselineCohortId,
    metric,
    delta: round(delta, metric === 'p99_latency' ? 0 : 3),
    threshold: round(threshold, metric === 'p99_latency' ? 0 : 3),
    severity,
    confidence: row.confidence,
    machineCount: row.machine_count,
    window,
    triggeredAt: nowIso,
    lastSeenAt: nowIso,
    state: 'active',
    reason
  };
  activeEventsByKey.set(key, created);
  recentEvents.push(created);
  appendOperatorAuditEvent(actorId, 'cohort.regression_triggered', 'cohort_evaluator', {
    cohortId: created.cohortId,
    baselineCohortId: created.baselineCohortId,
    metric: created.metric,
    delta: created.delta,
    threshold: created.threshold,
    severity: created.severity,
    confidence: created.confidence,
    window: created.window,
    correlationId: created.correlationId
  });
  return created;
}

function resolveActiveEvent(
  actorId: string,
  nowIso: string,
  cohortId: CohortId,
  baselineCohortId: CohortId,
  metric: CohortRegressionMetric,
  window: CohortWindow
): void {
  const key = eventKey(cohortId, baselineCohortId, metric, window);
  const existing = activeEventsByKey.get(key);
  if (!existing) {
    return;
  }

  const resolved: CohortEventInternal = {
    ...existing,
    state: 'resolved',
    lastSeenAt: nowIso,
    resolvedAt: nowIso
  };
  activeEventsByKey.delete(key);
  recentEvents.push(resolved);

  appendOperatorAuditEvent(actorId, 'cohort.regression_resolved', 'cohort_evaluator', {
    cohortId: resolved.cohortId,
    baselineCohortId: resolved.baselineCohortId,
    metric: resolved.metric,
    delta: resolved.delta,
    threshold: resolved.threshold,
    severity: resolved.severity,
    confidence: resolved.confidence,
    window: resolved.window,
    correlationId: resolved.correlationId
  });
}

function trimRecentEvents(max = 200): void {
  if (recentEvents.length <= max) {
    return;
  }
  recentEvents.splice(0, recentEvents.length - max);
}

export function evaluateCohorts(input: {
  window?: string;
  baselineCohortId?: string;
  actorId?: string;
}): CohortEvaluationView {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const actorId = input.actorId ?? 'system';
  const window = parseWindow(input.window);
  const baselineCohortId = parseBaseline(input.baselineCohortId);
  const thresholds = readThresholds();

  const rows = aggregateCurrentRows(nowMs);
  appendTrendSamples(rows, nowMs);

  const fallbackBaseline = rows.find((row) => row.cohort_id === baselineCohortId)
    ?? rows.find((row) => row.cohort_id === DEFAULT_BASELINE)
    ?? rows[0];

  const baselineRow: CohortEvaluationRowView = fallbackBaseline ?? {
    cohort_id: DEFAULT_BASELINE,
    machine_count: 0,
    error_rate_pct: 0,
    p50_latency_ms: 0,
    p95_latency_ms: 0,
    p99_latency_ms: 0,
    degradation_rate_pct: 0,
    config_distribution: {},
    delta_error_rate_pct: 0,
    delta_p99_latency_ms: 0,
    delta_degradation_rate_pct: 0,
    confidence: 'low',
    trend: [],
    active_event_count: 0
  };

  const activeEvents: CohortEventInternal[] = [];

  const rowsWithDeltas = rows.map((row) => {
    const deltaError = round(row.error_rate_pct - baselineRow.error_rate_pct, 3);
    const deltaP99 = Math.round(row.p99_latency_ms - baselineRow.p99_latency_ms);
    const deltaDegradation = round(row.degradation_rate_pct - baselineRow.degradation_rate_pct, 3);

    if (row.cohort_id !== baselineRow.cohort_id && row.machine_count > 0) {
      if (deltaP99 > thresholds.p99_latency_delta_ms) {
        activeEvents.push(
          upsertActiveEvent(
            actorId,
            nowIso,
            row,
            baselineRow.cohort_id,
            'p99_latency',
            deltaP99,
            thresholds.p99_latency_delta_ms,
            window
          )
        );
      } else {
        resolveActiveEvent(actorId, nowIso, row.cohort_id, baselineRow.cohort_id, 'p99_latency', window);
      }

      if (deltaError > thresholds.error_rate_delta_pct) {
        activeEvents.push(
          upsertActiveEvent(
            actorId,
            nowIso,
            row,
            baselineRow.cohort_id,
            'error_rate',
            deltaError,
            thresholds.error_rate_delta_pct,
            window
          )
        );
      } else {
        resolveActiveEvent(actorId, nowIso, row.cohort_id, baselineRow.cohort_id, 'error_rate', window);
      }

      if (deltaDegradation > thresholds.degradation_rate_delta_pct) {
        activeEvents.push(
          upsertActiveEvent(
            actorId,
            nowIso,
            row,
            baselineRow.cohort_id,
            'degradation_rate',
            deltaDegradation,
            thresholds.degradation_rate_delta_pct,
            window
          )
        );
      } else {
        resolveActiveEvent(actorId, nowIso, row.cohort_id, baselineRow.cohort_id, 'degradation_rate', window);
      }
    } else {
      resolveActiveEvent(actorId, nowIso, row.cohort_id, baselineRow.cohort_id, 'p99_latency', window);
      resolveActiveEvent(actorId, nowIso, row.cohort_id, baselineRow.cohort_id, 'error_rate', window);
      resolveActiveEvent(actorId, nowIso, row.cohort_id, baselineRow.cohort_id, 'degradation_rate', window);
    }

    const trend = buildTrendForWindow(row.cohort_id, window, nowMs);
    return {
      ...row,
      delta_error_rate_pct: deltaError,
      delta_p99_latency_ms: deltaP99,
      delta_degradation_rate_pct: deltaDegradation,
      trend
    };
  });

  const uniqueActiveEvents = [...new Map(activeEvents.map((event) => [event.eventId, event])).values()];
  const activeCountByCohort = new Map<CohortId, number>();
  for (const event of uniqueActiveEvents) {
    activeCountByCohort.set(event.cohortId, (activeCountByCohort.get(event.cohortId) ?? 0) + 1);
  }

  const finalRows = rowsWithDeltas.map((row) => ({
    ...row,
    active_event_count: activeCountByCohort.get(row.cohort_id) ?? 0
  }));

  trimRecentEvents(200);
  const recent = [...recentEvents]
    .filter((event) => event.baselineCohortId === baselineRow.cohort_id && event.window === window)
    .sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt))
    .slice(0, 60);

  return {
    generated_at: nowIso,
    source: 'cohort_evaluation_engine',
    baseline_cohort_id: baselineRow.cohort_id,
    window,
    thresholds,
    rows: finalRows,
    active_events: uniqueActiveEvents
      .sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt))
      .map(toEventView),
    recent_events: recent.map(toEventView)
  };
}
