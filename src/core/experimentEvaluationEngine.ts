import crypto from 'node:crypto';
import {
  evaluateCohorts,
  type CohortEvaluationView,
  type CohortEvaluationRowView,
  type CohortId,
  type CohortWindow,
  type CohortRegressionEventView
} from './cohortEvaluationEngine.js';
import { listAgentPresence } from '../store/agentPresenceStore.js';
import { appendOperatorAuditEvent } from './operatorAudit.js';

export type ExperimentPrimaryMetric = 'overload_likelihood' | 'focus_strength' | 'fatigue_probability';
export type ExperimentGuardrailMetric =
  | 'p99_latency_delta'
  | 'error_rate_delta'
  | 'degradation_delta'
  | 'intervention_thrash_rate';
export type ExperimentVerdictStatus =
  | 'improvement_confirmed'
  | 'regression_detected'
  | 'inconclusive'
  | 'auto_stop_recommended';
export type ExperimentEventType =
  | 'ExperimentStarted'
  | 'ExperimentUpdated'
  | 'ExperimentVerdictChanged'
  | 'ExperimentStopped';
export type ExperimentConfidenceLevel = 'low' | 'medium' | 'high';

export interface ExperimentDefinitionInput {
  name?: string;
  hypothesis?: string;
  window?: string;
  baseline_cohort_id?: string;
  experiment_cohort_id?: string;
  change_vector?: {
    policy_version?: string;
    config_seq?: number;
    threshold_set?: string;
  };
  primary_metrics?: string[];
  guardrails?: Array<{
    metric?: string;
    threshold?: number;
  }>;
  min_sample_machines?: number;
  min_coverage_pct?: number;
  min_window_minutes?: number;
}

interface ExperimentDefinition {
  name: string;
  hypothesis: string;
  window: CohortWindow;
  baselineCohortId: CohortId;
  experimentCohortId: CohortId;
  changeVector?: {
    policyVersion?: string;
    configSeq?: number;
    thresholdSet?: string;
  };
  primaryMetrics: ExperimentPrimaryMetric[];
  guardrails: Array<{
    metric: ExperimentGuardrailMetric;
    threshold: number;
  }>;
  minSampleMachines: number;
  minCoveragePct: number;
  minWindowMinutes: number;
}

interface ExperimentRuntime {
  experimentId: string;
  key: string;
  definition: ExperimentDefinition;
  lastVerdict: ExperimentVerdictStatus | null;
  state: 'active' | 'stop_recommended' | 'stopped';
  events: ExperimentLifecycleEventView[];
}

export interface ExperimentPrimaryMetricView {
  metric: ExperimentPrimaryMetric;
  baseline_value: number | null;
  experiment_value: number | null;
  delta: number | null;
  direction: 'up' | 'down';
  target_delta: number;
  improved: boolean | null;
}

export interface ExperimentGuardrailView {
  metric: ExperimentGuardrailMetric;
  baseline_value: number | null;
  experiment_value: number | null;
  delta: number | null;
  threshold: number;
  violated: boolean | null;
  strong_violation: boolean | null;
}

export interface ExperimentConfidenceView {
  level: ExperimentConfidenceLevel;
  score: number;
  machine_count: number;
  freshness_seconds: number;
  reasons: string[];
}

export interface ExperimentVerdictView {
  status: ExperimentVerdictStatus;
  summary: string;
  triggered_by: string;
  trigger_reason_code:
    | 'INSUFFICIENT_SAMPLE'
    | 'INSUFFICIENT_COVERAGE'
    | 'WINDOW_TOO_SHORT'
    | 'GUARDRAIL_STRONG_VIOLATION'
    | 'GUARDRAIL_VIOLATION'
    | 'IMPROVEMENT_CONFIRMED'
    | 'INCONCLUSIVE_LOW_CONFIDENCE'
    | 'INCONCLUSIVE_NO_PRIMARY_IMPROVEMENT';
  trigger_reason_details: Record<string, string | number | boolean | null>;
  auto_stop_recommended: boolean;
}

export interface ExperimentDataQualityView {
  baseline_sample_machines: number;
  experiment_sample_machines: number;
  min_sample_machines: number;
  baseline_coverage_pct: number;
  experiment_coverage_pct: number;
  min_coverage_pct: number;
  window_minutes: number;
  min_window_minutes: number;
  sample_valid: boolean;
  coverage_valid: boolean;
  window_valid: boolean;
  valid: boolean;
  messages: string[];
}

export interface ExperimentLifecycleEventView {
  event_id: string;
  type: ExperimentEventType;
  occurred_at_utc: string;
  message: string;
  verdict?: ExperimentVerdictStatus;
}

export interface ExperimentEvaluationView {
  experiment_id: string;
  evaluated_at_utc: string;
  definition: {
    name: string;
    hypothesis: string;
    window: CohortWindow;
    baseline_cohort_id: CohortId;
    experiment_cohort_id: CohortId;
    change_vector?: {
      policy_version?: string;
      config_seq?: number;
      threshold_set?: string;
    };
    primary_metrics: ExperimentPrimaryMetric[];
    guardrails: Array<{
      metric: ExperimentGuardrailMetric;
      threshold: number;
    }>;
    min_sample_machines: number;
    min_coverage_pct: number;
    min_window_minutes: number;
  };
  data_quality: ExperimentDataQualityView;
  metrics: {
    primary: ExperimentPrimaryMetricView[];
    guardrails: ExperimentGuardrailView[];
    interventions_per_min_delta: {
      baseline_value: number | null;
      experiment_value: number | null;
      delta: number | null;
    };
  };
  confidence: ExperimentConfidenceView;
  verdict: ExperimentVerdictView;
  evidence: {
    correlation_ids: string[];
    related_cohort_events: CohortRegressionEventView[];
  };
  timeline: {
    baseline: CohortEvaluationRowView['trend'];
    experiment: CohortEvaluationRowView['trend'];
    markers: Array<{
      timestamp_utc: string;
      type: ExperimentEventType;
      severity: 'info' | 'warning' | 'critical';
      message: string;
    }>;
  };
  events: ExperimentLifecycleEventView[];
}

const runtimesByKey = new Map<string, ExperimentRuntime>();
const runtimesById = new Map<string, ExperimentRuntime>();
const globalEvents: ExperimentLifecycleEventView[] = [];

const DEFAULT_PRIMARY_METRICS: ExperimentPrimaryMetric[] = ['overload_likelihood'];
const DEFAULT_GUARDRAILS: Array<{ metric: ExperimentGuardrailMetric; threshold: number }> = [
  { metric: 'p99_latency_delta', threshold: 20 },
  { metric: 'error_rate_delta', threshold: 0.1 },
  { metric: 'degradation_delta', threshold: 0.5 }
];

const STRONG_VIOLATION: Record<ExperimentGuardrailMetric, number> = {
  p99_latency_delta: 50,
  error_rate_delta: 0.5,
  degradation_delta: 1.0,
  intervention_thrash_rate: 3.0
};

const PRIMARY_TARGET_DELTA: Record<ExperimentPrimaryMetric, number> = {
  overload_likelihood: -0.05,
  focus_strength: 0.05,
  fatigue_probability: -0.04
};
const DEFAULT_MIN_SAMPLE_MACHINES = 20;
const DEFAULT_MIN_COVERAGE_PCT = 70;
const DEFAULT_MIN_WINDOW_MINUTES = 10;

function round(value: number, decimals = 3): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseWindow(value: string | undefined): CohortWindow {
  if (value === '15m' || value === '1h' || value === '6h' || value === '24h') {
    return value;
  }
  return '1h';
}

function parseCohortId(value: string | undefined, fallback: CohortId): CohortId {
  if (value === 'stable' || value === 'canary-1' || value === 'canary-5' || value === 'internal' || value === 'experimental') {
    return value;
  }
  return fallback;
}

function parsePositiveNumber(raw: number | undefined, fallback: number): number {
  return Number.isFinite(raw) && Number(raw) > 0 ? Number(raw) : fallback;
}

function parsePercent(raw: number | undefined, fallback: number): number {
  return clamp(parsePositiveNumber(raw, fallback), 1, 100);
}

function windowToMinutes(window: CohortWindow): number {
  if (window === '15m') return 15;
  if (window === '1h') return 60;
  if (window === '6h') return 360;
  return 1440;
}

function parsePrimaryMetrics(input: string[] | undefined): ExperimentPrimaryMetric[] {
  if (!Array.isArray(input) || input.length === 0) {
    return [...DEFAULT_PRIMARY_METRICS];
  }

  const normalized = input
    .map((entry) => entry?.toString().trim())
    .filter((entry): entry is string => Boolean(entry))
    .filter((entry): entry is ExperimentPrimaryMetric =>
      entry === 'overload_likelihood' || entry === 'focus_strength' || entry === 'fatigue_probability'
    );

  const unique = Array.from(new Set(normalized));
  return unique.length > 0 ? unique.slice(0, 2) : [...DEFAULT_PRIMARY_METRICS];
}

function parseGuardrails(
  input: ExperimentDefinitionInput['guardrails']
): Array<{ metric: ExperimentGuardrailMetric; threshold: number }> {
  if (!Array.isArray(input) || input.length === 0) {
    return [...DEFAULT_GUARDRAILS];
  }

  const parsed = input
    .map((entry) => {
      const metricRaw = entry?.metric?.toString().trim();
      const thresholdRaw = Number(entry?.threshold);
      const metric: ExperimentGuardrailMetric | undefined =
        metricRaw === 'p99_latency_delta' ||
        metricRaw === 'error_rate_delta' ||
        metricRaw === 'degradation_delta' ||
        metricRaw === 'intervention_thrash_rate'
          ? metricRaw
          : undefined;

      if (!metric) {
        return undefined;
      }

      const fallback = DEFAULT_GUARDRAILS.find((guardrail) => guardrail.metric === metric)?.threshold ?? 0;
      const threshold = Number.isFinite(thresholdRaw) && thresholdRaw > 0 ? thresholdRaw : fallback;
      return {
        metric,
        threshold
      };
    })
    .filter((entry): entry is { metric: ExperimentGuardrailMetric; threshold: number } => Boolean(entry));

  const dedup = new Map<ExperimentGuardrailMetric, { metric: ExperimentGuardrailMetric; threshold: number }>();
  for (const guardrail of parsed) {
    dedup.set(guardrail.metric, guardrail);
  }

  const values = Array.from(dedup.values());
  return values.length > 0 ? values.slice(0, 4) : [...DEFAULT_GUARDRAILS];
}

function normalizeDefinition(input: ExperimentDefinitionInput): ExperimentDefinition {
  const name = typeof input.name === 'string' && input.name.trim().length > 0 ? input.name.trim() : 'Untitled experiment';
  const hypothesis =
    typeof input.hypothesis === 'string' && input.hypothesis.trim().length > 0
      ? input.hypothesis.trim()
      : 'No hypothesis provided.';
  const baselineCohortId = parseCohortId(input.baseline_cohort_id, 'stable');
  const experimentCohortId = parseCohortId(input.experiment_cohort_id, 'canary-1');
  const primaryMetrics = parsePrimaryMetrics(input.primary_metrics);
  const guardrails = parseGuardrails(input.guardrails);
  const minSampleMachines = Math.max(1, Math.trunc(parsePositiveNumber(input.min_sample_machines, DEFAULT_MIN_SAMPLE_MACHINES)));
  const minCoveragePct = parsePercent(input.min_coverage_pct, DEFAULT_MIN_COVERAGE_PCT);
  const minWindowMinutes = Math.max(1, Math.trunc(parsePositiveNumber(input.min_window_minutes, DEFAULT_MIN_WINDOW_MINUTES)));

  const changeVector =
    input.change_vector && typeof input.change_vector === 'object'
      ? {
          ...(typeof input.change_vector.policy_version === 'string' ? { policyVersion: input.change_vector.policy_version } : {}),
          ...(Number.isFinite(Number(input.change_vector.config_seq))
            ? { configSeq: Math.max(0, Math.trunc(Number(input.change_vector.config_seq))) }
            : {}),
          ...(typeof input.change_vector.threshold_set === 'string' ? { thresholdSet: input.change_vector.threshold_set } : {})
        }
      : undefined;

  return {
    name,
    hypothesis,
    window: parseWindow(input.window),
    baselineCohortId,
    experimentCohortId,
    ...(changeVector && Object.keys(changeVector).length > 0 ? { changeVector } : {}),
    primaryMetrics,
    guardrails,
    minSampleMachines,
    minCoveragePct,
    minWindowMinutes
  };
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

function runtimeKey(definition: ExperimentDefinition): string {
  return [
    definition.name.toLowerCase(),
    definition.window,
    definition.baselineCohortId,
    definition.experimentCohortId
  ].join('|');
}

function appendExperimentEvent(
  runtime: ExperimentRuntime,
  type: ExperimentEventType,
  message: string,
  verdict?: ExperimentVerdictStatus
): ExperimentLifecycleEventView {
  const event: ExperimentLifecycleEventView = {
    event_id: crypto.randomUUID(),
    type,
    occurred_at_utc: new Date().toISOString(),
    message,
    ...(verdict ? { verdict } : {})
  };
  runtime.events.push(event);
  globalEvents.push(event);
  if (runtime.events.length > 80) {
    runtime.events.splice(0, runtime.events.length - 80);
  }
  if (globalEvents.length > 500) {
    globalEvents.splice(0, globalEvents.length - 500);
  }
  return event;
}

function ensureRuntime(definition: ExperimentDefinition, actorId: string): ExperimentRuntime {
  const key = runtimeKey(definition);
  const existing = runtimesByKey.get(key);
  if (existing) {
    existing.definition = definition;
    return existing;
  }

  const runtime: ExperimentRuntime = {
    experimentId: crypto.randomUUID(),
    key,
    definition,
    lastVerdict: null,
    state: 'active',
    events: []
  };
  runtimesByKey.set(key, runtime);
  runtimesById.set(runtime.experimentId, runtime);

  appendExperimentEvent(runtime, 'ExperimentStarted', `Experiment "${definition.name}" started.`);
  appendOperatorAuditEvent(actorId, 'experiment.started', 'experiment_evaluator', {
    experimentId: runtime.experimentId,
    name: definition.name,
    baselineCohortId: definition.baselineCohortId,
    experimentCohortId: definition.experimentCohortId,
    window: definition.window
  });
  return runtime;
}

function findCohortRow(snapshot: CohortEvaluationView, cohortId: CohortId): CohortEvaluationRowView {
  return (
    snapshot.rows.find((row) => row.cohort_id === cohortId) ??
    ({
      cohort_id: cohortId,
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
    } satisfies CohortEvaluationRowView)
  );
}

function derivedMetrics(row: CohortEvaluationRowView): {
  overloadLikelihood: number;
  fatigueProbability: number;
  focusStrength: number;
  interventionsPerMin: number;
} {
  const overloadLikelihood = clamp(
    (row.degradation_rate_pct * 0.22) + (row.error_rate_pct * 0.55) + ((row.p99_latency_ms / 300) * 0.25),
    0,
    1
  );
  const fatigueProbability = clamp(
    (row.degradation_rate_pct * 0.18) + (row.error_rate_pct * 0.35) + ((row.p95_latency_ms / 300) * 0.2),
    0,
    1
  );
  const focusStrength = clamp(1 - ((overloadLikelihood * 0.6) + (fatigueProbability * 0.4)), 0, 1);
  const interventionsPerMin = clamp(
    0.2 + (row.degradation_rate_pct * 1.3) + (row.error_rate_pct * 1.4),
    0,
    15
  );

  return {
    overloadLikelihood: round(overloadLikelihood, 4),
    fatigueProbability: round(fatigueProbability, 4),
    focusStrength: round(focusStrength, 4),
    interventionsPerMin: round(interventionsPerMin, 4)
  };
}

function computePrimaryMetricView(
  metric: ExperimentPrimaryMetric,
  baseline: ReturnType<typeof derivedMetrics>,
  experiment: ReturnType<typeof derivedMetrics>
): ExperimentPrimaryMetricView {
  const targetDelta = PRIMARY_TARGET_DELTA[metric];

  if (metric === 'overload_likelihood') {
    const delta = round(experiment.overloadLikelihood - baseline.overloadLikelihood, 4);
    return {
      metric,
      baseline_value: baseline.overloadLikelihood,
      experiment_value: experiment.overloadLikelihood,
      delta,
      direction: 'down',
      target_delta: targetDelta,
      improved: delta <= targetDelta
    };
  }

  if (metric === 'fatigue_probability') {
    const delta = round(experiment.fatigueProbability - baseline.fatigueProbability, 4);
    return {
      metric,
      baseline_value: baseline.fatigueProbability,
      experiment_value: experiment.fatigueProbability,
      delta,
      direction: 'down',
      target_delta: targetDelta,
      improved: delta <= targetDelta
    };
  }

  const delta = round(experiment.focusStrength - baseline.focusStrength, 4);
  return {
    metric,
    baseline_value: baseline.focusStrength,
    experiment_value: experiment.focusStrength,
    delta,
    direction: 'up',
    target_delta: targetDelta,
    improved: delta >= targetDelta
  };
}

function computeGuardrailView(
  guardrail: { metric: ExperimentGuardrailMetric; threshold: number },
  baselineRow: CohortEvaluationRowView,
  experimentRow: CohortEvaluationRowView,
  baselineDerived: ReturnType<typeof derivedMetrics>,
  experimentDerived: ReturnType<typeof derivedMetrics>
): ExperimentGuardrailView {
  if (guardrail.metric === 'p99_latency_delta') {
    const delta = round(experimentRow.p99_latency_ms - baselineRow.p99_latency_ms, 3);
    return {
      metric: guardrail.metric,
      baseline_value: baselineRow.p99_latency_ms,
      experiment_value: experimentRow.p99_latency_ms,
      delta,
      threshold: guardrail.threshold,
      violated: delta > guardrail.threshold,
      strong_violation: delta > STRONG_VIOLATION.p99_latency_delta
    };
  }

  if (guardrail.metric === 'error_rate_delta') {
    const delta = round(experimentRow.error_rate_pct - baselineRow.error_rate_pct, 4);
    return {
      metric: guardrail.metric,
      baseline_value: baselineRow.error_rate_pct,
      experiment_value: experimentRow.error_rate_pct,
      delta,
      threshold: guardrail.threshold,
      violated: delta > guardrail.threshold,
      strong_violation: delta > STRONG_VIOLATION.error_rate_delta
    };
  }

  if (guardrail.metric === 'degradation_delta') {
    const delta = round(experimentRow.degradation_rate_pct - baselineRow.degradation_rate_pct, 4);
    return {
      metric: guardrail.metric,
      baseline_value: baselineRow.degradation_rate_pct,
      experiment_value: experimentRow.degradation_rate_pct,
      delta,
      threshold: guardrail.threshold,
      violated: delta > guardrail.threshold,
      strong_violation: delta > STRONG_VIOLATION.degradation_delta
    };
  }

  const delta = round(experimentDerived.interventionsPerMin - baselineDerived.interventionsPerMin, 4);
  return {
    metric: guardrail.metric,
    baseline_value: baselineDerived.interventionsPerMin,
    experiment_value: experimentDerived.interventionsPerMin,
    delta,
    threshold: guardrail.threshold,
    violated: delta > guardrail.threshold,
    strong_violation: delta > STRONG_VIOLATION.intervention_thrash_rate
  };
}

function cohortFreshnessSeconds(cohortId: CohortId): number {
  const now = Date.now();
  const rows = listAgentPresence().filter((presence) => cohortForAgentId(presence.agentId) === cohortId);
  if (rows.length === 0) {
    return 9999;
  }

  const latestMs = rows.reduce((latest, row) => {
    const parsed = Date.parse(row.lastHeartbeatUtc);
    if (!Number.isFinite(parsed)) return latest;
    return Math.max(latest, parsed);
  }, 0);

  if (!Number.isFinite(latestMs) || latestMs <= 0) {
    return 9999;
  }
  return Math.max(0, Math.round((now - latestMs) / 1000));
}

function primaryMetricVariance(primary: ExperimentPrimaryMetric, row: CohortEvaluationRowView): number {
  if (row.trend.length <= 1) {
    return 0;
  }

  const values = row.trend.map((point) => {
    if (primary === 'overload_likelihood') {
      return clamp((point.degradation_rate_pct * 0.22) + (point.error_rate_pct * 0.55) + ((point.p99_latency_ms / 300) * 0.25), 0, 1);
    }
    if (primary === 'fatigue_probability') {
      return clamp((point.degradation_rate_pct * 0.18) + (point.error_rate_pct * 0.35) + ((point.p99_latency_ms / 300) * 0.2), 0, 1);
    }
    const overload = clamp((point.degradation_rate_pct * 0.22) + (point.error_rate_pct * 0.55) + ((point.p99_latency_ms / 300) * 0.25), 0, 1);
    const fatigue = clamp((point.degradation_rate_pct * 0.18) + (point.error_rate_pct * 0.35) + ((point.p99_latency_ms / 300) * 0.2), 0, 1);
    return clamp(1 - ((overload * 0.6) + (fatigue * 0.4)), 0, 1);
  });

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean <= 0) {
    return 0;
  }
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function computeConfidence(
  definition: ExperimentDefinition,
  baselineRow: CohortEvaluationRowView,
  experimentRow: CohortEvaluationRowView
): ExperimentConfidenceView {
  const machineCount = Math.min(baselineRow.machine_count, experimentRow.machine_count);
  const freshness = Math.min(
    cohortFreshnessSeconds(definition.baselineCohortId),
    cohortFreshnessSeconds(definition.experimentCohortId)
  );

  let score = machineCount > 100 ? 0.85 : machineCount >= 20 ? 0.67 : 0.38;
  const reasons: string[] = [];

  if (machineCount < 20) {
    reasons.push('Low cohort sample size.');
  } else if (machineCount <= 100) {
    reasons.push('Moderate cohort sample size.');
  } else {
    reasons.push('Large cohort sample size.');
  }

  if (freshness > 120) {
    score -= 0.35;
    reasons.push('Data freshness stale (>120s).');
  } else if (freshness > 60) {
    score -= 0.2;
    reasons.push('Data freshness degraded (>60s).');
  } else {
    reasons.push('Data freshness healthy.');
  }

  if (experimentRow.trend.length < 3 || baselineRow.trend.length < 3) {
    score -= 0.15;
    reasons.push('Insufficient timeline samples.');
  }

  const variance = definition.primaryMetrics.reduce((sum, metric) => sum + primaryMetricVariance(metric, experimentRow), 0)
    / Math.max(1, definition.primaryMetrics.length);
  if (variance > 0.6) {
    score -= 0.25;
    reasons.push('High metric variance.');
  } else if (variance > 0.35) {
    score -= 0.12;
    reasons.push('Moderate metric variance.');
  } else {
    reasons.push('Variance within expected range.');
  }

  const normalized = clamp(round(score, 3), 0, 1);
  const level: ExperimentConfidenceLevel = normalized >= 0.75 ? 'high' : normalized >= 0.5 ? 'medium' : 'low';

  return {
    level,
    score: normalized,
    machine_count: Math.max(0, machineCount),
    freshness_seconds: freshness,
    reasons
  };
}

function computeDataQuality(
  definition: ExperimentDefinition,
  baselineRow: CohortEvaluationRowView,
  experimentRow: CohortEvaluationRowView
): ExperimentDataQualityView {
  const baselineSample = Math.max(0, baselineRow.machine_count);
  const experimentSample = Math.max(0, experimentRow.machine_count);
  const baselineCoverage = round((baselineSample / Math.max(1, definition.minSampleMachines)) * 100, 2);
  const experimentCoverage = round((experimentSample / Math.max(1, definition.minSampleMachines)) * 100, 2);
  const coverageFloor = Math.min(baselineCoverage, experimentCoverage);
  const windowMinutes = windowToMinutes(definition.window);

  const sampleValid = baselineSample >= definition.minSampleMachines && experimentSample >= definition.minSampleMachines;
  const coverageValid = coverageFloor >= definition.minCoveragePct;
  const windowValid = windowMinutes >= definition.minWindowMinutes;
  const valid = sampleValid && coverageValid && windowValid;

  const messages: string[] = [];
  if (!sampleValid) {
    messages.push('Not enough machines reporting for baseline/experiment.');
  }
  if (!coverageValid) {
    messages.push('Coverage below minimum requirement.');
  }
  if (!windowValid) {
    messages.push('Selected window shorter than minimum duration.');
  }
  if (valid) {
    messages.push('Data quality checks passed.');
  }

  return {
    baseline_sample_machines: baselineSample,
    experiment_sample_machines: experimentSample,
    min_sample_machines: definition.minSampleMachines,
    baseline_coverage_pct: round(clamp(baselineCoverage, 0, 999), 2),
    experiment_coverage_pct: round(clamp(experimentCoverage, 0, 999), 2),
    min_coverage_pct: definition.minCoveragePct,
    window_minutes: windowMinutes,
    min_window_minutes: definition.minWindowMinutes,
    sample_valid: sampleValid,
    coverage_valid: coverageValid,
    window_valid: windowValid,
    valid,
    messages
  };
}

function computeVerdict(
  primary: ExperimentPrimaryMetricView[],
  guardrails: ExperimentGuardrailView[],
  confidence: ExperimentConfidenceView,
  dataQuality: ExperimentDataQualityView
): ExperimentVerdictView {
  if (!dataQuality.sample_valid) {
    return {
      status: 'inconclusive',
      summary: 'Experiment outcome is inconclusive due to insufficient sample size.',
      triggered_by: 'Not enough machines reporting in baseline/experiment cohorts.',
      trigger_reason_code: 'INSUFFICIENT_SAMPLE',
      trigger_reason_details: {
        baseline_machine_count: dataQuality.baseline_sample_machines,
        experiment_machine_count: dataQuality.experiment_sample_machines,
        min_required: dataQuality.min_sample_machines
      },
      auto_stop_recommended: false
    };
  }

  if (!dataQuality.coverage_valid) {
    return {
      status: 'inconclusive',
      summary: 'Experiment outcome is inconclusive due to low coverage.',
      triggered_by: 'Coverage below configured minimum.',
      trigger_reason_code: 'INSUFFICIENT_COVERAGE',
      trigger_reason_details: {
        baseline_coverage_pct: dataQuality.baseline_coverage_pct,
        experiment_coverage_pct: dataQuality.experiment_coverage_pct,
        min_coverage_pct: dataQuality.min_coverage_pct
      },
      auto_stop_recommended: false
    };
  }

  if (!dataQuality.window_valid) {
    return {
      status: 'inconclusive',
      summary: 'Experiment outcome is inconclusive because window duration is too short.',
      triggered_by: 'Selected window does not meet minimum duration.',
      trigger_reason_code: 'WINDOW_TOO_SHORT',
      trigger_reason_details: {
        window_minutes: dataQuality.window_minutes,
        min_window_minutes: dataQuality.min_window_minutes
      },
      auto_stop_recommended: false
    };
  }

  const violating = guardrails.filter((guardrail) => guardrail.violated === true);
  const strongViolation = guardrails.find((guardrail) => guardrail.strong_violation === true);
  const primaryImprovedCount = primary.filter((metric) => metric.improved === true).length;
  const allPrimaryImproved = primary.length > 0 && primaryImprovedCount === primary.length;

  if (strongViolation) {
    return {
      status: 'auto_stop_recommended',
      summary: 'Auto-stop recommended due to strong guardrail violation.',
      triggered_by: `${strongViolation.metric} exceeded strong threshold.`,
      trigger_reason_code: 'GUARDRAIL_STRONG_VIOLATION',
      trigger_reason_details: {
        metric: strongViolation.metric,
        delta: strongViolation.delta,
        threshold: strongViolation.threshold
      },
      auto_stop_recommended: true
    };
  }

  if (violating.length > 0) {
    return {
      status: 'regression_detected',
      summary: 'Regression detected. Guardrail threshold violated.',
      triggered_by: violating.map((guardrail) => guardrail.metric).join(', '),
      trigger_reason_code: 'GUARDRAIL_VIOLATION',
      trigger_reason_details: {
        metrics: violating.map((guardrail) => guardrail.metric).join(','),
        violations: violating.length
      },
      auto_stop_recommended: false
    };
  }

  if (allPrimaryImproved && confidence.level !== 'low') {
    return {
      status: 'improvement_confirmed',
      summary: 'Improvement confirmed with guardrails healthy.',
      triggered_by: primary.map((metric) => metric.metric).join(', '),
      trigger_reason_code: 'IMPROVEMENT_CONFIRMED',
      trigger_reason_details: {
        improved_metrics: primaryImprovedCount,
        total_primary_metrics: primary.length,
        confidence_level: confidence.level
      },
      auto_stop_recommended: false
    };
  }

  if (confidence.level === 'low') {
    return {
      status: 'inconclusive',
      summary: 'Experiment outcome is inconclusive.',
      triggered_by: 'Low confidence / sample variance.',
      trigger_reason_code: 'INCONCLUSIVE_LOW_CONFIDENCE',
      trigger_reason_details: {
        confidence_level: confidence.level,
        confidence_score: confidence.score
      },
      auto_stop_recommended: false
    };
  }

  return {
    status: 'inconclusive',
    summary: 'Experiment outcome is inconclusive.',
    triggered_by: 'Primary improvement criteria not met.',
    trigger_reason_code: 'INCONCLUSIVE_NO_PRIMARY_IMPROVEMENT',
    trigger_reason_details: {
      improved_metrics: primaryImprovedCount,
      total_primary_metrics: primary.length
    },
    auto_stop_recommended: false
  };
}

function maybeEmitVerdictEvents(runtime: ExperimentRuntime, verdict: ExperimentVerdictView, actorId: string): void {
  appendExperimentEvent(runtime, 'ExperimentUpdated', `Evaluation refreshed: ${verdict.summary}`, verdict.status);

  if (runtime.lastVerdict !== verdict.status) {
    appendExperimentEvent(
      runtime,
      'ExperimentVerdictChanged',
      runtime.lastVerdict
        ? `Verdict changed: ${runtime.lastVerdict} -> ${verdict.status}.`
        : `Initial verdict: ${verdict.status}.`,
      verdict.status
    );
    appendOperatorAuditEvent(actorId, 'experiment.verdict_changed', 'experiment_evaluator', {
      experimentId: runtime.experimentId,
      name: runtime.definition.name,
      previousVerdict: runtime.lastVerdict ?? null,
      nextVerdict: verdict.status,
      triggeredBy: verdict.triggered_by
    });
  }

  if (verdict.status === 'auto_stop_recommended' && runtime.state === 'active') {
    runtime.state = 'stop_recommended';
    appendExperimentEvent(
      runtime,
      'ExperimentStopped',
      'Stop recommended by evaluator due to strong guardrail violation.',
      verdict.status
    );
    appendOperatorAuditEvent(actorId, 'experiment.stop_recommended', 'experiment_evaluator', {
      experimentId: runtime.experimentId,
      name: runtime.definition.name,
      verdict: verdict.status
    });
  }

  runtime.lastVerdict = verdict.status;
}

export function evaluateExperiment(input: {
  actorId: string;
  definition: ExperimentDefinitionInput;
}): ExperimentEvaluationView {
  const definition = normalizeDefinition(input.definition);
  const runtime = ensureRuntime(definition, input.actorId);

  const cohortSnapshot = evaluateCohorts({
    window: definition.window,
    baselineCohortId: definition.baselineCohortId,
    actorId: input.actorId
  });
  const baselineRow = findCohortRow(cohortSnapshot, definition.baselineCohortId);
  const experimentRow = findCohortRow(cohortSnapshot, definition.experimentCohortId);

  const baselineDerived = derivedMetrics(baselineRow);
  const experimentDerived = derivedMetrics(experimentRow);
  const confidence = computeConfidence(definition, baselineRow, experimentRow);
  const dataQuality = computeDataQuality(definition, baselineRow, experimentRow);

  const computedPrimary = definition.primaryMetrics.map((metric) =>
    computePrimaryMetricView(metric, baselineDerived, experimentDerived)
  );
  const computedGuardrails = definition.guardrails.map((guardrail) =>
    computeGuardrailView(guardrail, baselineRow, experimentRow, baselineDerived, experimentDerived)
  );

  const primary = dataQuality.sample_valid
    ? computedPrimary
    : computedPrimary.map((metric) => ({
        ...metric,
        baseline_value: null,
        experiment_value: null,
        delta: null,
        improved: null
      }));
  const guardrails = dataQuality.sample_valid
    ? computedGuardrails
    : computedGuardrails.map((guardrail) => ({
        ...guardrail,
        baseline_value: null,
        experiment_value: null,
        delta: null,
        violated: null,
        strong_violation: null
      }));

  const interventionsDelta = dataQuality.sample_valid
    ? {
        baseline_value: baselineDerived.interventionsPerMin,
        experiment_value: experimentDerived.interventionsPerMin,
        delta: round(experimentDerived.interventionsPerMin - baselineDerived.interventionsPerMin, 4)
      }
    : {
        baseline_value: null,
        experiment_value: null,
        delta: null
      };

  const verdict = computeVerdict(primary, guardrails, confidence, dataQuality);

  maybeEmitVerdictEvents(runtime, verdict, input.actorId);

  const relevantEvents = cohortSnapshot.active_events.filter(
    (event) =>
      event.cohort_id === definition.experimentCohortId &&
      event.baseline_cohort_id === definition.baselineCohortId &&
      event.window === definition.window
  );
  const evidenceCorrelationIds = Array.from(new Set(relevantEvents.map((event) => event.correlation_id)));

  return {
    experiment_id: runtime.experimentId,
    evaluated_at_utc: new Date().toISOString(),
    definition: {
      name: definition.name,
      hypothesis: definition.hypothesis,
      window: definition.window,
      baseline_cohort_id: definition.baselineCohortId,
      experiment_cohort_id: definition.experimentCohortId,
      ...(definition.changeVector
        ? {
            change_vector: {
              ...(definition.changeVector.policyVersion ? { policy_version: definition.changeVector.policyVersion } : {}),
              ...(Number.isFinite(Number(definition.changeVector.configSeq))
                ? { config_seq: Number(definition.changeVector.configSeq) }
                : {}),
              ...(definition.changeVector.thresholdSet ? { threshold_set: definition.changeVector.thresholdSet } : {})
            }
          }
        : {}),
      primary_metrics: definition.primaryMetrics,
      guardrails: definition.guardrails,
      min_sample_machines: definition.minSampleMachines,
      min_coverage_pct: definition.minCoveragePct,
      min_window_minutes: definition.minWindowMinutes
    },
    data_quality: dataQuality,
    metrics: {
      primary,
      guardrails,
      interventions_per_min_delta: interventionsDelta
    },
    confidence,
    verdict,
    evidence: {
      correlation_ids: evidenceCorrelationIds,
      related_cohort_events: relevantEvents
    },
    timeline: {
      baseline: baselineRow.trend,
      experiment: experimentRow.trend,
      markers: runtime.events.slice(-20).map((event) => ({
        timestamp_utc: event.occurred_at_utc,
        type: event.type,
        severity: event.verdict === 'auto_stop_recommended' || event.verdict === 'regression_detected'
          ? 'critical'
          : event.verdict === 'inconclusive'
            ? 'warning'
            : 'info',
        message: event.message
      }))
    },
    events: runtime.events.slice(-30)
  };
}

export function listExperimentEvents(input: {
  experimentId?: string;
  limit?: number;
}): ExperimentLifecycleEventView[] {
  const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 100)));
  if (input.experimentId && runtimesById.has(input.experimentId)) {
    const runtime = runtimesById.get(input.experimentId)!;
    return runtime.events.slice(-limit);
  }
  return globalEvents.slice(-limit);
}

export function stopExperiment(input: {
  actorId: string;
  experimentId: string;
  reason?: string;
}): { stopped: boolean; experiment_id: string } {
  const runtime = runtimesById.get(input.experimentId);
  if (!runtime) {
    return { stopped: false, experiment_id: input.experimentId };
  }

  if (runtime.state === 'stopped') {
    return { stopped: false, experiment_id: input.experimentId };
  }

  runtime.state = 'stopped';
  appendExperimentEvent(runtime, 'ExperimentStopped', input.reason ?? 'Experiment stopped by operator.', runtime.lastVerdict ?? undefined);
  appendOperatorAuditEvent(input.actorId, 'experiment.stopped', 'experiment_evaluator', {
    experimentId: runtime.experimentId,
    name: runtime.definition.name,
    reason: input.reason ?? 'operator_stop'
  });
  return { stopped: true, experiment_id: input.experimentId };
}
