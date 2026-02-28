import type { AuditEvent } from '@porta/api-contracts';
import type { RolloutState } from '@porta/api-contracts';
import { evaluateCohorts, type CohortId, type CohortEvaluationView, type CohortRegressionMetric } from './cohortEvaluationEngine.js';
import { readOperatorAuditEvents } from './operatorAudit.js';
import { listAgentPresence } from '../store/agentPresenceStore.js';
import { runtimeState } from '../store/runtimeState.js';

type GuardrailStatus = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'NOT_APPLICABLE';
type PromotionVerdict = 'ALLOW' | 'BLOCK' | 'INCONCLUSIVE';

type RolloutGuardrailId =
  | 'ERROR_RATE'
  | 'P99'
  | 'DEGRADATION'
  | 'SIGNATURE_TRUST'
  | 'CIRCUIT_BREAKER'
  | 'FSM'
  | 'COOLDOWN'
  | 'FEATURE_GATE';

type RolloutDecisionReasonCode =
  | 'ALL_GUARDRAILS_PASS'
  | 'INSUFFICIENT_SAMPLE'
  | 'INSUFFICIENT_COVERAGE'
  | 'STREAM_STALE'
  | 'TRUST_UNKNOWN'
  | 'COOLDOWN_ACTIVE'
  | 'FSM_BLOCKED'
  | 'FEATURE_GATE_DISABLED'
  | 'CIRCUIT_OPEN'
  | 'SIGNATURE_INVALID'
  | 'SLO_RISK_TOO_HIGH'
  | 'GUARDRAIL_INCONCLUSIVE';

type TrustStatus = 'VALID' | 'INVALID' | 'UNKNOWN';
type AdapterPromotionStage = 'CANARY' | 'LIMITED' | 'MAJORITY' | 'FULL';

type RolloutEventType =
  | 'RolloutPlanGenerated'
  | 'PromotionRequested'
  | 'PromotionBlocked'
  | 'PromotionExecuted'
  | 'MonitoringStarted'
  | 'GuardrailFailed'
  | 'CooldownActivated'
  | 'HaltRaised'
  | 'RollbackStarted'
  | 'RollbackCompleted'
  | 'RolloutEvent';

type Primitive = string | number | boolean | null;

interface RolloutGuardrailView {
  guardrail_id: RolloutGuardrailId;
  status: GuardrailStatus;
  value: number | null;
  value_label: string;
  threshold: number | null;
  threshold_label: string;
  window: string;
  evidence: {
    correlation_ids: string[];
    cohorts: CohortId[];
    trace_refs: string[];
  };
  reason_code?: string;
  reason_details?: Record<string, Primitive>;
}

interface RolloutDataQualityView {
  baseline_cohort_id: CohortId;
  target_cohort_id: CohortId;
  sample_size_by_cohort: Record<CohortId, number>;
  coverage_pct_by_cohort: Record<CohortId, number>;
  min_sample_machines: number;
  min_coverage_pct: number;
  freshness_seconds: number | null;
  freshness_ok: boolean;
  ws_stream_ok: boolean;
  metrics_available: boolean;
  trust_status: TrustStatus;
  sample_valid: boolean;
  coverage_valid: boolean;
  valid: boolean;
  messages: string[];
}

interface RolloutDecisionView {
  promotion_verdict: PromotionVerdict;
  trigger_reason_code: RolloutDecisionReasonCode;
  trigger_reason_details: Record<string, Primitive>;
  evaluated_at_utc: string;
}

interface RolloutBlastRadiusView {
  node_count: number | null;
  impacted_cohorts: CohortId[];
  confidence: 'low' | 'medium' | 'high' | 'unknown';
  generated_at_utc: string;
  availability_reason_code?: string;
}

interface RolloutDryRunPredictionView {
  error_rate_delta_pct: number | null;
  p99_latency_delta_ms: number | null;
  degradation_rate_delta_pct: number | null;
  generated_at_utc: string;
  availability_reason_code?: string;
}

interface RolloutEventView {
  event_id: string;
  type: RolloutEventType;
  timestamp_utc: string;
  actor: string;
  config_version: number;
  cohorts: CohortId[];
  correlation_ids: string[];
  details: string;
}

export interface RolloutEvaluationView {
  rollout_state: RolloutState;
  halt_status: boolean;
  current_stage: AdapterPromotionStage;
  next_stage: AdapterPromotionStage | null;
  config_version: number;
  cooldown_until_utc: string | null;
  evaluated_at_utc: string;
  data_quality: RolloutDataQualityView;
  guardrail_eval: RolloutGuardrailView[];
  decision: RolloutDecisionView;
  blast_radius: RolloutBlastRadiusView;
  dry_run_prediction: RolloutDryRunPredictionView;
  rollout_stage_progression_preview: RolloutState[];
  events: RolloutEventView[];
  evidence: {
    correlation_ids: string[];
    available: boolean;
    generated_at_utc: string;
  };
}

export interface RolloutEvidencePackView {
  generated_at_utc: string;
  evaluation: RolloutEvaluationView;
  cohort_snapshot: CohortEvaluationView;
  event_stream: RolloutEventView[];
  guardrail_eval: RolloutGuardrailView[];
  correlation_ids: string[];
}

const COHORT_IDS: CohortId[] = ['stable', 'canary-1', 'canary-5', 'internal', 'experimental'];
const ROLLOUT_GUARDRAIL_WINDOW = '10m';

function parseNonNegative(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.trunc(parsed)) : fallback;
}

function round(value: number, decimals = 3): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function staleHeartbeatSeconds(): number {
  return parsePositiveInt(process.env.NODE_STALE_HEARTBEAT_SECONDS, 30);
}

function rolloutMinSample(): number {
  return parsePositiveInt(process.env.ROLLOUT_MIN_SAMPLE_MACHINES, 20);
}

function rolloutMinCoverage(): number {
  const parsed = parseNonNegative(process.env.ROLLOUT_MIN_COVERAGE_PCT, 70);
  return Math.min(100, Math.max(1, round(parsed, 2)));
}

function thresholdP99DeltaMs(): number {
  return parseNonNegative(process.env.COHORT_TRIGGER_DELTA_P99_MS, 20);
}

function thresholdErrorDeltaPct(): number {
  return parseNonNegative(process.env.COHORT_TRIGGER_DELTA_ERROR_RATE_PCT, 0.5);
}

function thresholdDegradationDeltaPct(): number {
  return parseNonNegative(process.env.COHORT_TRIGGER_DELTA_DEGRADATION_PCT, 1.0);
}

function featureGateEnabled(): boolean {
  const raw = process.env.CONTROL_PLANE_ADAPTER_EXPANSION_ENABLED ?? 'false';
  return raw === '1' || raw.toLowerCase() === 'true';
}

function nextStage(stage: AdapterPromotionStage): AdapterPromotionStage | null {
  if (stage === 'CANARY') return 'LIMITED';
  if (stage === 'LIMITED') return 'MAJORITY';
  if (stage === 'MAJORITY') return 'FULL';
  return null;
}

function targetCohortForStage(stage: AdapterPromotionStage): CohortId {
  if (stage === 'CANARY') return 'canary-1';
  if (stage === 'LIMITED') return 'canary-5';
  return 'stable';
}

function progressionPreview(state: RolloutState): RolloutState[] {
  if (state === 'IDLE') return ['PROMOTING', 'MONITORING', 'IDLE'];
  if (state === 'PROMOTING') return ['PROMOTING', 'MONITORING', 'IDLE'];
  if (state === 'MONITORING') return ['MONITORING', 'IDLE'];
  if (state === 'HALTED') return ['HALTED', 'ROLLED_BACK', 'COOLDOWN', 'IDLE'];
  if (state === 'ROLLED_BACK') return ['ROLLED_BACK', 'COOLDOWN', 'IDLE'];
  return ['COOLDOWN', 'IDLE'];
}

function confidenceForMachineCount(machineCount: number): 'low' | 'medium' | 'high' {
  if (machineCount > 100) return 'high';
  if (machineCount >= 20) return 'medium';
  return 'low';
}

function readMetaString(event: AuditEvent, key: string): string | undefined {
  if (!event.metadata || typeof event.metadata !== 'object') return undefined;
  const value = event.metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readMetaNumber(event: AuditEvent, key: string): number | undefined {
  if (!event.metadata || typeof event.metadata !== 'object') return undefined;
  const value = event.metadata[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readMetaCohorts(event: AuditEvent): CohortId[] {
  const candidates = [
    readMetaString(event, 'cohortId'),
    readMetaString(event, 'cohort'),
    readMetaString(event, 'targetCohort'),
    readMetaString(event, 'cohorts'),
    readMetaString(event, 'allowedCohorts')
  ].filter((value): value is string => Boolean(value));

  const values = new Set<CohortId>();
  for (const candidate of candidates) {
    for (const part of candidate.split(',').map((item) => item.trim())) {
      if (COHORT_IDS.includes(part as CohortId)) {
        values.add(part as CohortId);
      }
    }
  }
  return [...values];
}

function mapAuditEventType(event: AuditEvent): RolloutEventType {
  const action = event.action;
  if (action === 'rollout.transition') {
    const toState = readMetaString(event, 'to');
    if (toState === 'PROMOTING') return 'PromotionExecuted';
    if (toState === 'MONITORING') return 'MonitoringStarted';
    if (toState === 'HALTED') return 'HaltRaised';
    if (toState === 'ROLLED_BACK') return 'RollbackStarted';
    if (toState === 'COOLDOWN') return 'CooldownActivated';
    if (toState === 'IDLE') return 'RollbackCompleted';
    return 'RolloutEvent';
  }
  if (action === 'rollout.transition_rejected') return 'PromotionBlocked';
  if (action === 'rollout.auto_rollback_executed') return 'RollbackCompleted';
  if (action === 'adapter.promotion_blocked') return 'PromotionBlocked';
  if (action === 'adapter.promotion_advanced') return 'PromotionExecuted';
  if (action === 'cohort.regression_triggered') return 'GuardrailFailed';
  if (action === 'cohort.regression_resolved') return 'RolloutEvent';
  return 'RolloutEvent';
}

function mappedRolloutEvents(limit = 120): RolloutEventView[] {
  const rows = readOperatorAuditEvents(Math.max(limit * 3, 200))
    .filter((event) => {
      return (
        event.action.startsWith('rollout.')
        || event.action.startsWith('adapter.')
        || event.action.startsWith('cohort.regression')
      );
    })
    .slice(-Math.max(limit, 1))
    .reverse();

  return rows.map((event) => {
    const correlation = readMetaString(event, 'correlationId') ?? readMetaString(event, 'correlation_id');
    const configSeq = readMetaNumber(event, 'configSeq') ?? runtimeState.currentConfigSeq;
    const cohorts = readMetaCohorts(event);
    return {
      event_id: event.eventId,
      type: mapAuditEventType(event),
      timestamp_utc: event.occurredAtUtc,
      actor: event.actorId,
      config_version: configSeq,
      cohorts,
      correlation_ids: correlation ? [correlation] : [],
      details: event.action
    };
  });
}

function metricToGuardrailId(metric: CohortRegressionMetric): RolloutGuardrailId {
  if (metric === 'error_rate') return 'ERROR_RATE';
  if (metric === 'p99_latency') return 'P99';
  return 'DEGRADATION';
}

function metricCorrelations(snapshot: CohortEvaluationView, baseline: CohortId, target: CohortId): Map<RolloutGuardrailId, string[]> {
  const map = new Map<RolloutGuardrailId, string[]>();
  for (const event of snapshot.active_events) {
    if (event.baseline_cohort_id !== baseline || event.cohort_id !== target) continue;
    const guardrailId = metricToGuardrailId(event.metric);
    const current = map.get(guardrailId) ?? [];
    if (!current.includes(event.correlation_id)) {
      current.push(event.correlation_id);
    }
    map.set(guardrailId, current);
  }
  return map;
}

function buildMetricGuardrail(input: {
  guardrailId: RolloutGuardrailId;
  delta: number | null;
  threshold: number;
  sampleValid: boolean;
  metricsAvailable: boolean;
  reasonDetails: Record<string, Primitive>;
  evidenceCorrelationIds: string[];
  baselineCohortId: CohortId;
  targetCohortId: CohortId;
}): RolloutGuardrailView {
  const evidence = {
    correlation_ids: input.evidenceCorrelationIds,
    cohorts: [input.baselineCohortId, input.targetCohortId] as CohortId[],
    trace_refs: input.evidenceCorrelationIds.map((id) => `trace:${id}`)
  };

  if (!input.metricsAvailable || !input.sampleValid || input.delta === null) {
    return {
      guardrail_id: input.guardrailId,
      status: 'INCONCLUSIVE',
      value: null,
      value_label: 'n/a',
      threshold: input.threshold,
      threshold_label: `${input.threshold}`,
      window: ROLLOUT_GUARDRAIL_WINDOW,
      evidence,
      reason_code: 'INSUFFICIENT_SAMPLE',
      reason_details: input.reasonDetails
    };
  }

  const breached = input.delta > input.threshold;
  return {
    guardrail_id: input.guardrailId,
    status: breached ? 'FAIL' : 'PASS',
    value: round(input.delta, input.guardrailId === 'P99' ? 0 : 3),
    value_label: input.guardrailId === 'P99' ? `${Math.round(input.delta)} ms` : `${round(input.delta, 3)}%`,
    threshold: input.threshold,
    threshold_label: input.guardrailId === 'P99' ? `${Math.round(input.threshold)} ms` : `${round(input.threshold, 3)}%`,
    window: ROLLOUT_GUARDRAIL_WINDOW,
    evidence,
    ...(breached
      ? {
          reason_code: 'THRESHOLD_EXCEEDED',
          reason_details: {
            delta: round(input.delta, 3),
            threshold: round(input.threshold, 3)
          }
        }
      : {})
  };
}

function decisionFromGuardrails(input: {
  guardrails: RolloutGuardrailView[];
  dataQuality: RolloutDataQualityView;
  cooldownActive: boolean;
  evaluatedAtUtc: string;
}): RolloutDecisionView {
  if (!input.dataQuality.sample_valid) {
    return {
      promotion_verdict: 'INCONCLUSIVE',
      trigger_reason_code: 'INSUFFICIENT_SAMPLE',
      trigger_reason_details: {
        baseline_cohort: input.dataQuality.baseline_cohort_id,
        target_cohort: input.dataQuality.target_cohort_id,
        baseline_count: input.dataQuality.sample_size_by_cohort[input.dataQuality.baseline_cohort_id],
        target_count: input.dataQuality.sample_size_by_cohort[input.dataQuality.target_cohort_id],
        min_required: input.dataQuality.min_sample_machines
      },
      evaluated_at_utc: input.evaluatedAtUtc
    };
  }

  if (!input.dataQuality.coverage_valid) {
    return {
      promotion_verdict: 'INCONCLUSIVE',
      trigger_reason_code: 'INSUFFICIENT_COVERAGE',
      trigger_reason_details: {
        baseline_coverage_pct: input.dataQuality.coverage_pct_by_cohort[input.dataQuality.baseline_cohort_id],
        target_coverage_pct: input.dataQuality.coverage_pct_by_cohort[input.dataQuality.target_cohort_id],
        min_coverage_pct: input.dataQuality.min_coverage_pct
      },
      evaluated_at_utc: input.evaluatedAtUtc
    };
  }

  if (!input.dataQuality.freshness_ok) {
    return {
      promotion_verdict: 'INCONCLUSIVE',
      trigger_reason_code: 'STREAM_STALE',
      trigger_reason_details: {
        freshness_seconds: input.dataQuality.freshness_seconds,
        stale_limit_seconds: staleHeartbeatSeconds() * 2
      },
      evaluated_at_utc: input.evaluatedAtUtc
    };
  }

  if (input.dataQuality.trust_status === 'UNKNOWN') {
    return {
      promotion_verdict: 'INCONCLUSIVE',
      trigger_reason_code: 'TRUST_UNKNOWN',
      trigger_reason_details: {
        trust_status: input.dataQuality.trust_status
      },
      evaluated_at_utc: input.evaluatedAtUtc
    };
  }

  if (input.cooldownActive) {
    return {
      promotion_verdict: 'BLOCK',
      trigger_reason_code: 'COOLDOWN_ACTIVE',
      trigger_reason_details: {
        cooldown_until_utc: runtimeState.cooldownUntilUtc ?? null
      },
      evaluated_at_utc: input.evaluatedAtUtc
    };
  }

  const firstFail = input.guardrails.find((guardrail) => guardrail.status === 'FAIL');
  if (firstFail) {
    let code: RolloutDecisionReasonCode = 'SLO_RISK_TOO_HIGH';
    if (firstFail.guardrail_id === 'COOLDOWN') code = 'COOLDOWN_ACTIVE';
    if (firstFail.guardrail_id === 'FSM') code = 'FSM_BLOCKED';
    if (firstFail.guardrail_id === 'FEATURE_GATE') code = 'FEATURE_GATE_DISABLED';
    if (firstFail.guardrail_id === 'CIRCUIT_BREAKER') code = 'CIRCUIT_OPEN';
    if (firstFail.guardrail_id === 'SIGNATURE_TRUST') code = 'SIGNATURE_INVALID';
    return {
      promotion_verdict: 'BLOCK',
      trigger_reason_code: code,
      trigger_reason_details: {
        guardrail_id: firstFail.guardrail_id,
        ...(firstFail.reason_details ?? {})
      },
      evaluated_at_utc: input.evaluatedAtUtc
    };
  }

  if (input.guardrails.some((guardrail) => guardrail.status === 'INCONCLUSIVE')) {
    return {
      promotion_verdict: 'INCONCLUSIVE',
      trigger_reason_code: 'GUARDRAIL_INCONCLUSIVE',
      trigger_reason_details: {
        inconclusive_guardrails: input.guardrails
          .filter((guardrail) => guardrail.status === 'INCONCLUSIVE')
          .map((guardrail) => guardrail.guardrail_id)
          .join(',')
      },
      evaluated_at_utc: input.evaluatedAtUtc
    };
  }

  return {
    promotion_verdict: 'ALLOW',
    trigger_reason_code: 'ALL_GUARDRAILS_PASS',
    trigger_reason_details: {
      guardrails_checked: input.guardrails.length
    },
    evaluated_at_utc: input.evaluatedAtUtc
  };
}

export function evaluateRollout(actorId: string): RolloutEvaluationView {
  const evaluatedAtUtc = new Date().toISOString();
  const minSample = rolloutMinSample();
  const minCoverage = rolloutMinCoverage();
  const stage = runtimeState.adapterControls.promotionStage;
  const baselineCohortId: CohortId = 'stable';
  const targetCohortId = targetCohortForStage(stage);
  const nextPromotionStage = nextStage(stage);
  const snapshot = evaluateCohorts({ window: '1h', baselineCohortId, actorId });
  const events = mappedRolloutEvents(120);

  const byCohort = new Map(snapshot.rows.map((row) => [row.cohort_id, row]));
  const baselineRow = byCohort.get(baselineCohortId);
  const targetRow = byCohort.get(targetCohortId);
  const sampleSizeByCohort = {
    stable: byCohort.get('stable')?.machine_count ?? 0,
    'canary-1': byCohort.get('canary-1')?.machine_count ?? 0,
    'canary-5': byCohort.get('canary-5')?.machine_count ?? 0,
    internal: byCohort.get('internal')?.machine_count ?? 0,
    experimental: byCohort.get('experimental')?.machine_count ?? 0
  } satisfies Record<CohortId, number>;

  const coveragePctByCohort = {
    stable: round((sampleSizeByCohort.stable / minSample) * 100, 2),
    'canary-1': round((sampleSizeByCohort['canary-1'] / minSample) * 100, 2),
    'canary-5': round((sampleSizeByCohort['canary-5'] / minSample) * 100, 2),
    internal: round((sampleSizeByCohort.internal / minSample) * 100, 2),
    experimental: round((sampleSizeByCohort.experimental / minSample) * 100, 2)
  } satisfies Record<CohortId, number>;

  const baselineCount = sampleSizeByCohort[baselineCohortId];
  const targetCount = sampleSizeByCohort[targetCohortId];
  const sampleValid = baselineCount >= minSample && targetCount >= minSample;
  const coverageValid = Math.min(coveragePctByCohort[baselineCohortId], coveragePctByCohort[targetCohortId]) >= minCoverage;

  const presences = listAgentPresence();
  const latestHeartbeatMs = presences.reduce<number | null>((latest, presence) => {
    const parsed = Date.parse(presence.lastHeartbeatUtc);
    if (!Number.isFinite(parsed)) return latest;
    if (latest === null || parsed > latest) return parsed;
    return latest;
  }, null);

  const freshnessSeconds = latestHeartbeatMs === null
    ? null
    : Math.max(0, Math.round((Date.now() - latestHeartbeatMs) / 1000));
  const freshnessOk = freshnessSeconds !== null && freshnessSeconds <= staleHeartbeatSeconds() * 2;
  const wsStreamOk = freshnessOk && presences.length > 0;
  const metricsAvailable = baselineCount > 0 && targetCount > 0;
  const trustStatus: TrustStatus = runtimeState.currentConfigSignatureValid === true
    ? 'VALID'
    : runtimeState.currentConfigSignatureValid === false
      ? 'INVALID'
      : 'UNKNOWN';

  const dataMessages: string[] = [];
  if (!sampleValid) dataMessages.push('Not enough machines reporting for baseline/target cohorts.');
  if (!coverageValid) dataMessages.push('Coverage below configured minimum.');
  if (!freshnessOk) dataMessages.push('Heartbeat stream is stale or missing.');
  if (!metricsAvailable) dataMessages.push('Metrics unavailable for baseline/target cohorts.');
  if (trustStatus !== 'VALID') dataMessages.push('Config trust not fully valid.');
  if (dataMessages.length === 0) dataMessages.push('Data quality checks passed.');

  const dataQuality: RolloutDataQualityView = {
    baseline_cohort_id: baselineCohortId,
    target_cohort_id: targetCohortId,
    sample_size_by_cohort: sampleSizeByCohort,
    coverage_pct_by_cohort: coveragePctByCohort,
    min_sample_machines: minSample,
    min_coverage_pct: minCoverage,
    freshness_seconds: freshnessSeconds,
    freshness_ok: freshnessOk,
    ws_stream_ok: wsStreamOk,
    metrics_available: metricsAvailable,
    trust_status: trustStatus,
    sample_valid: sampleValid,
    coverage_valid: coverageValid,
    valid: sampleValid && coverageValid && freshnessOk && metricsAvailable && trustStatus === 'VALID',
    messages: dataMessages
  };

  const errorDelta = baselineRow && targetRow ? round(targetRow.error_rate_pct - baselineRow.error_rate_pct, 3) : null;
  const p99Delta = baselineRow && targetRow ? round(targetRow.p99_latency_ms - baselineRow.p99_latency_ms, 0) : null;
  const degradationDelta = baselineRow && targetRow ? round(targetRow.degradation_rate_pct - baselineRow.degradation_rate_pct, 3) : null;

  const metricCorrelationsByGuardrail = metricCorrelations(snapshot, baselineCohortId, targetCohortId);
  const sampleReasonDetails = {
    baseline_count: baselineCount,
    target_count: targetCount,
    min_required: minSample
  } satisfies Record<string, Primitive>;

  const guardrails: RolloutGuardrailView[] = [
    buildMetricGuardrail({
      guardrailId: 'ERROR_RATE',
      delta: errorDelta,
      threshold: thresholdErrorDeltaPct(),
      sampleValid,
      metricsAvailable,
      reasonDetails: sampleReasonDetails,
      evidenceCorrelationIds: metricCorrelationsByGuardrail.get('ERROR_RATE') ?? [],
      baselineCohortId,
      targetCohortId
    }),
    buildMetricGuardrail({
      guardrailId: 'P99',
      delta: p99Delta,
      threshold: thresholdP99DeltaMs(),
      sampleValid,
      metricsAvailable,
      reasonDetails: sampleReasonDetails,
      evidenceCorrelationIds: metricCorrelationsByGuardrail.get('P99') ?? [],
      baselineCohortId,
      targetCohortId
    }),
    buildMetricGuardrail({
      guardrailId: 'DEGRADATION',
      delta: degradationDelta,
      threshold: thresholdDegradationDeltaPct(),
      sampleValid,
      metricsAvailable,
      reasonDetails: sampleReasonDetails,
      evidenceCorrelationIds: metricCorrelationsByGuardrail.get('DEGRADATION') ?? [],
      baselineCohortId,
      targetCohortId
    }),
    {
      guardrail_id: 'SIGNATURE_TRUST',
      status: trustStatus === 'VALID' ? 'PASS' : trustStatus === 'INVALID' ? 'FAIL' : 'INCONCLUSIVE',
      value: null,
      value_label: trustStatus,
      threshold: null,
      threshold_label: 'VALID',
      window: ROLLOUT_GUARDRAIL_WINDOW,
      evidence: { correlation_ids: [], cohorts: [baselineCohortId], trace_refs: [] },
      ...(trustStatus !== 'VALID'
        ? {
            reason_code: trustStatus === 'INVALID' ? 'SIGNATURE_INVALID' : 'SIGNATURE_UNKNOWN',
            reason_details: {
              trust_status: trustStatus
            }
          }
        : {})
    },
    (() => {
      const gateEnabled = featureGateEnabled();
      if (!gateEnabled) {
        return {
          guardrail_id: 'CIRCUIT_BREAKER' as const,
          status: 'NOT_APPLICABLE' as const,
          value: null,
          value_label: 'feature gate disabled',
          threshold: null,
          threshold_label: 'n/a',
          window: ROLLOUT_GUARDRAIL_WINDOW,
          evidence: { correlation_ids: [], cohorts: [targetCohortId], trace_refs: [] },
          reason_code: 'FEATURE_GATE_DISABLED',
          reason_details: { feature_gate_enabled: false }
        };
      }
      if (!runtimeState.adapterControls.featureAdapterEnabled) {
        return {
          guardrail_id: 'CIRCUIT_BREAKER' as const,
          status: 'NOT_APPLICABLE' as const,
          value: null,
          value_label: 'adapter disabled',
          threshold: runtimeState.adapterControls.circuitBreakerThreshold,
          threshold_label: `${runtimeState.adapterControls.circuitBreakerThreshold}%`,
          window: ROLLOUT_GUARDRAIL_WINDOW,
          evidence: { correlation_ids: [], cohorts: [targetCohortId], trace_refs: [] },
          reason_code: 'ADAPTER_NOT_ENABLED',
          reason_details: { adapter_enabled: false }
        };
      }
      if (!metricsAvailable || !sampleValid || targetRow == null) {
        return {
          guardrail_id: 'CIRCUIT_BREAKER' as const,
          status: 'INCONCLUSIVE' as const,
          value: null,
          value_label: 'n/a',
          threshold: runtimeState.adapterControls.circuitBreakerThreshold,
          threshold_label: `${runtimeState.adapterControls.circuitBreakerThreshold}%`,
          window: ROLLOUT_GUARDRAIL_WINDOW,
          evidence: { correlation_ids: [], cohorts: [targetCohortId], trace_refs: [] },
          reason_code: 'INSUFFICIENT_SAMPLE',
          reason_details: sampleReasonDetails
        };
      }

      const value = round(targetRow.error_rate_pct, 3);
      const threshold = runtimeState.adapterControls.circuitBreakerThreshold;
      const opened = value >= threshold;
      return {
        guardrail_id: 'CIRCUIT_BREAKER' as const,
        status: opened ? 'FAIL' : 'PASS',
        value,
        value_label: `${value}%`,
        threshold,
        threshold_label: `${threshold}%`,
        window: ROLLOUT_GUARDRAIL_WINDOW,
        evidence: { correlation_ids: [], cohorts: [targetCohortId], trace_refs: [] },
        ...(opened
          ? {
              reason_code: 'CIRCUIT_OPEN',
              reason_details: {
                value,
                threshold
              }
            }
          : {})
      };
    })(),
    (() => {
      const state = runtimeState.rolloutState;
      const blocked = state === 'HALTED' || state === 'ROLLED_BACK';
      return {
        guardrail_id: 'FSM' as const,
        status: blocked ? 'FAIL' as const : 'PASS' as const,
        value: null,
        value_label: state,
        threshold: null,
        threshold_label: 'IDLE|PROMOTING|MONITORING',
        window: ROLLOUT_GUARDRAIL_WINDOW,
        evidence: { correlation_ids: [], cohorts: [targetCohortId], trace_refs: [] },
        ...(blocked
          ? {
              reason_code: 'FSM_BLOCKED',
              reason_details: { rollout_state: state }
            }
          : {})
      };
    })(),
    (() => {
      const cooldownActive = Boolean(
        runtimeState.cooldownUntilUtc
        && Number.isFinite(Date.parse(runtimeState.cooldownUntilUtc))
        && Date.parse(runtimeState.cooldownUntilUtc) > Date.now()
      );
      return {
        guardrail_id: 'COOLDOWN' as const,
        status: cooldownActive ? 'FAIL' : 'PASS',
        value: null,
        value_label: cooldownActive ? 'active' : 'inactive',
        threshold: null,
        threshold_label: 'inactive',
        window: ROLLOUT_GUARDRAIL_WINDOW,
        evidence: { correlation_ids: [], cohorts: [targetCohortId], trace_refs: [] },
        ...(cooldownActive
          ? {
              reason_code: 'COOLDOWN_ACTIVE',
              reason_details: { cooldown_until_utc: runtimeState.cooldownUntilUtc ?? null }
            }
          : {})
      };
    })(),
    (() => {
      const gateEnabled = featureGateEnabled();
      return {
        guardrail_id: 'FEATURE_GATE' as const,
        status: gateEnabled ? 'PASS' : 'FAIL',
        value: null,
        value_label: gateEnabled ? 'enabled' : 'disabled',
        threshold: null,
        threshold_label: 'enabled',
        window: ROLLOUT_GUARDRAIL_WINDOW,
        evidence: { correlation_ids: [], cohorts: [targetCohortId], trace_refs: [] },
        ...(!gateEnabled
          ? {
              reason_code: 'FEATURE_GATE_DISABLED',
              reason_details: { feature_gate_enabled: false }
            }
          : {})
      };
    })()
  ];

  const cooldownActive = guardrails.some((guardrail) => guardrail.guardrail_id === 'COOLDOWN' && guardrail.status === 'FAIL');
  const decision = decisionFromGuardrails({
    guardrails,
    dataQuality,
    cooldownActive,
    evaluatedAtUtc
  });

  const blastRadius: RolloutBlastRadiusView = metricsAvailable
    ? {
        node_count: targetCount,
        impacted_cohorts: [targetCohortId],
        confidence: confidenceForMachineCount(targetCount),
        generated_at_utc: evaluatedAtUtc
      }
    : {
        node_count: null,
        impacted_cohorts: [targetCohortId],
        confidence: 'unknown',
        generated_at_utc: evaluatedAtUtc,
        availability_reason_code: 'INSUFFICIENT_SAMPLE'
      };

  const dryRunPrediction: RolloutDryRunPredictionView = metricsAvailable && sampleValid
    ? {
        error_rate_delta_pct: errorDelta,
        p99_latency_delta_ms: p99Delta,
        degradation_rate_delta_pct: degradationDelta,
        generated_at_utc: evaluatedAtUtc
      }
    : {
        error_rate_delta_pct: null,
        p99_latency_delta_ms: null,
        degradation_rate_delta_pct: null,
        generated_at_utc: evaluatedAtUtc,
        availability_reason_code: 'INSUFFICIENT_SAMPLE'
      };

  const correlationSet = new Set<string>();
  for (const guardrail of guardrails) {
    for (const id of guardrail.evidence.correlation_ids) {
      correlationSet.add(id);
    }
  }
  for (const event of events) {
    for (const id of event.correlation_ids) {
      correlationSet.add(id);
    }
  }
  const evidenceCorrelationIds = [...correlationSet];

  return {
    rollout_state: runtimeState.rolloutState,
    halt_status:
      runtimeState.rolloutState === 'HALTED'
      || runtimeState.rolloutState === 'ROLLED_BACK'
      || runtimeState.rolloutState === 'COOLDOWN',
    current_stage: stage,
    next_stage: nextPromotionStage,
    config_version: runtimeState.currentConfigSeq,
    cooldown_until_utc: runtimeState.cooldownUntilUtc ?? null,
    evaluated_at_utc: evaluatedAtUtc,
    data_quality: dataQuality,
    guardrail_eval: guardrails,
    decision,
    blast_radius: blastRadius,
    dry_run_prediction: dryRunPrediction,
    rollout_stage_progression_preview: progressionPreview(runtimeState.rolloutState),
    events,
    evidence: {
      correlation_ids: evidenceCorrelationIds,
      available: evidenceCorrelationIds.length > 0,
      generated_at_utc: evaluatedAtUtc
    }
  };
}

export function buildRolloutEvidencePack(actorId: string, eventLimit = 200): RolloutEvidencePackView {
  const evaluation = evaluateRollout(actorId);
  const cohortSnapshot = evaluateCohorts({ window: '1h', baselineCohortId: 'stable', actorId });
  return {
    generated_at_utc: new Date().toISOString(),
    evaluation,
    cohort_snapshot: cohortSnapshot,
    event_stream: evaluation.events.slice(0, Math.max(1, eventLimit)),
    guardrail_eval: evaluation.guardrail_eval,
    correlation_ids: evaluation.evidence.correlation_ids
  };
}
