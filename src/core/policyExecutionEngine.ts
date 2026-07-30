import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appendDecisionTrace, appendInterventionCommand, incrementAuditMetric } from './policyGovernanceStore.js';

export type PolicyActionType = 'scale_horizontal' | 'restart_pods' | 'traffic_shift';

export interface PolicyMetricSample {
  schema_name: string;
  metric_name: string;
  aggregation: 'avg' | 'p95' | 'p99' | 'max' | 'min';
  window_seconds: number;
  value: number;
}

export interface PolicyEvaluationRequest {
  environment: string;
  service?: string;
  region?: string;
  metrics: PolicyMetricSample[];
  timestamp?: string;
  correlation_id?: string;
  kill_switch_enabled?: boolean;
}

export interface PolicyEvaluationResponse {
  evaluated_at: string;
  triggered_policy_ids_in_order: string[];
  blocked_policy_ids: string[];
  signed_commands: SignedInterventionCommand[];
  states: Record<string, ServiceExecutionState>;
}

interface TriggerRule {
  schema_name: string;
  metric_name: string;
  aggregation: 'avg' | 'p95' | 'p99' | 'max' | 'min';
  window_seconds: number;
}

interface ConditionRule {
  operator: '>' | '>=' | '<' | '<=' | '==' | '!=';
  threshold: number;
}

type ExecutionAction =
  | { type: 'scale_horizontal'; min_replicas: number; max_replicas: number; scale_step: number }
  | { type: 'restart_pods'; max_parallel: number }
  | { type: 'traffic_shift'; shift_percentage: number; target_cluster: string };

interface ExecutionPolicy {
  policy_id: string;
  priority: number;
  enabled: boolean;
  resource_scope: {
    service: string;
    environment: string;
    region?: string;
  };
  trigger: TriggerRule;
  condition: ConditionRule;
  action: ExecutionAction;
  cool_down_seconds: number;
  max_triggers_per_hour: number;
}

export interface ServiceExecutionState {
  replicas: number;
  last_scale_time: string | null;
  last_policy_trigger: string | null;
  trigger_count_last_hour: number;
  version: number;
}

interface PolicyRuntimeState {
  last_trigger_at: string | null;
  trigger_timestamps: string[];
}

interface EngineRuntimeState {
  services: Record<string, ServiceExecutionState>;
  policies: Record<string, PolicyRuntimeState>;
  intervention_timestamps: string[];
  scale_events: Record<string, Array<{ timestamp: string; delta: number }>>;
  traffic_shift_events: Record<string, Array<{ timestamp: string; shift: number }>>;
}

export interface SignedInterventionCommand {
  command_id: string;
  policy_id: string;
  target_service: string;
  action: PolicyActionType;
  parameters: Record<string, string | number | boolean>;
  issued_at: string;
  expires_at: string;
  state_version: number;
  signature_input_hash: string;
  signature: {
    algorithm: 'Ed25519';
    key_id: 'cp-root-key-01';
    signature: string;
  };
}

const runtimePath = path.resolve('.data', 'policy-engine-state.json');
const privateKeyPath = path.resolve('signer-private.pem');

/**
 * No compiled-in fallback -- see the note in policyGovernanceStore. The key that used to sit
 * here was a real one, and it signed production's intervention commands.
 */
function readSigningPrivateKey(): string {
  const fromEnv = process.env.CONTROL_PLANE_SIGNING_PRIVATE_KEY_PEM?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  if (fs.existsSync(privateKeyPath)) {
    return fs.readFileSync(privateKeyPath, 'utf8');
  }

  throw new Error(
    'The control-plane signing private key is not configured. Set ' +
      'CONTROL_PLANE_SIGNING_PRIVATE_KEY_PEM or provide signer-private.pem. ' +
      'There is no built-in key by design.'
  );
}

const policies: ExecutionPolicy[] = [
  {
    policy_id: '018f9b74-ff6a-7b10-baa1-6f4e77a2d901',
    priority: 100,
    enabled: true,
    resource_scope: { service: 'payments-api', environment: 'prod', region: 'us-east-1' },
    trigger: {
      schema_name: 'control.telemetry.metric',
      metric_name: 'cpu_usage_percent',
      aggregation: 'p95',
      window_seconds: 60
    },
    condition: { operator: '>', threshold: 85.0 },
    action: { type: 'scale_horizontal', min_replicas: 6, max_replicas: 20, scale_step: 2 },
    cool_down_seconds: 300,
    max_triggers_per_hour: 6
  },
  {
    policy_id: '018f9b75-43c2-7e30-91fa-924ae9ab4c33',
    priority: 200,
    enabled: true,
    resource_scope: { service: 'payments-api', environment: 'prod' },
    trigger: {
      schema_name: 'control.telemetry.metric',
      metric_name: 'memory_usage_percent',
      aggregation: 'avg',
      window_seconds: 300
    },
    condition: { operator: '>', threshold: 92.0 },
    action: { type: 'restart_pods', max_parallel: 1 },
    cool_down_seconds: 900,
    max_triggers_per_hour: 2
  },
  {
    policy_id: '018f9b76-a2de-7023-bbb3-6a51a911e2d0',
    priority: 50,
    enabled: true,
    resource_scope: { service: 'checkout-api', environment: 'prod' },
    trigger: {
      schema_name: 'control.telemetry.metric',
      metric_name: 'http_latency_ms',
      aggregation: 'p99',
      window_seconds: 120
    },
    condition: { operator: '>', threshold: 750 },
    action: { type: 'traffic_shift', shift_percentage: 20, target_cluster: 'checkout-api-prod-green' },
    cool_down_seconds: 600,
    max_triggers_per_hour: 4
  }
];

const MAX_SCALE_PER_10_MIN = 6;
const MAX_TRAFFIC_SHIFT_PER_HOUR = 50;
const GLOBAL_INTERVENTION_CAP_PER_HOUR = 30;

function ensureDataDir(): void {
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

function deterministicUuid(seed: string): string {
  const hex = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function signPayload(payload: unknown): { hash: string; signature: string } {
  const canonical = canonicalize(payload);
  const hash = crypto.createHash('sha256').update(canonical).digest('hex');
  const privateKey = readSigningPrivateKey();
  const signature = crypto.sign(null, Buffer.from(hash, 'utf8'), privateKey).toString('base64');
  return { hash, signature };
}

function compare(actual: number, condition: ConditionRule): boolean {
  switch (condition.operator) {
    case '>':
      return actual > condition.threshold;
    case '>=':
      return actual >= condition.threshold;
    case '<':
      return actual < condition.threshold;
    case '<=':
      return actual <= condition.threshold;
    case '==':
      return actual === condition.threshold;
    case '!=':
      return actual !== condition.threshold;
    default:
      return false;
  }
}

function loadState(): EngineRuntimeState {
  ensureDataDir();
  if (!fs.existsSync(runtimePath)) {
    return {
      services: {
        'prod/payments-api': {
          replicas: 8,
          last_scale_time: null,
          last_policy_trigger: null,
          trigger_count_last_hour: 0,
          version: 0
        },
        'prod/checkout-api': {
          replicas: 12,
          last_scale_time: null,
          last_policy_trigger: null,
          trigger_count_last_hour: 0,
          version: 0
        }
      },
      policies: {},
      intervention_timestamps: [],
      scale_events: {},
      traffic_shift_events: {}
    };
  }

  return JSON.parse(fs.readFileSync(runtimePath, 'utf8')) as EngineRuntimeState;
}

function persistState(state: EngineRuntimeState): void {
  ensureDataDir();
  const tmpPath = `${runtimePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  fs.renameSync(tmpPath, runtimePath);
}

function pruneHistory(nowMs: number, timestamps: string[], windowMs: number): string[] {
  return timestamps.filter((ts) => nowMs - Date.parse(ts) <= windowMs);
}

function serviceKey(environment: string, service: string): string {
  return `${environment}/${service}`;
}

function findMetric(request: PolicyEvaluationRequest, policy: ExecutionPolicy): PolicyMetricSample | undefined {
  return request.metrics.find(
    (m) =>
      m.schema_name === policy.trigger.schema_name &&
      m.metric_name === policy.trigger.metric_name &&
      m.aggregation === policy.trigger.aggregation &&
      m.window_seconds === policy.trigger.window_seconds
  );
}

function evaluatePoliciesSorted(): ExecutionPolicy[] {
  return policies
    .filter((p) => p.enabled)
    .sort((a, b) => (a.priority === b.priority ? a.policy_id.localeCompare(b.policy_id) : a.priority - b.priority));
}

export function evaluatePolicyEngine(request: PolicyEvaluationRequest): PolicyEvaluationResponse {
  const now = request.timestamp ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const correlationId = request.correlation_id ?? deterministicUuid(`corr:${request.environment}:${request.service ?? 'all'}:${now}`);
  const killSwitch = request.kill_switch_enabled ?? true;
  const state = loadState();

  state.intervention_timestamps = pruneHistory(nowMs, state.intervention_timestamps, 60 * 60 * 1000);

  const triggered: string[] = [];
  const blocked: string[] = [];
  const commands: SignedInterventionCommand[] = [];

  for (const policy of evaluatePoliciesSorted()) {
    if (policy.resource_scope.environment !== request.environment) {
      continue;
    }
    if (request.service && policy.resource_scope.service !== request.service) {
      continue;
    }
    if (policy.resource_scope.region && request.region && policy.resource_scope.region !== request.region) {
      continue;
    }

    const metric = findMetric(request, policy);
    const sKey = serviceKey(policy.resource_scope.environment, policy.resource_scope.service);
    const serviceState = state.services[sKey];
    if (!serviceState || !metric) {
      blocked.push(policy.policy_id);
      appendDecisionTrace({
        trace_id: deterministicUuid(`${policy.policy_id}:${now}:blocked:missing_metric`),
        correlation_id: correlationId,
        timestamp: now,
        policy_id: policy.policy_id,
        state_version: serviceState?.version ?? 0,
        target_service: policy.resource_scope.service,
        metrics_snapshot: metric
          ? { [metric.metric_name]: metric.value, [`${metric.aggregation}_window`]: metric.window_seconds }
          : { missing_metric: true },
        condition_result: false,
        action_decision: 'blocked',
        action_parameters: { reason: 'missing_metric_or_state' },
        confidence_score: 0.0,
        triggered_by: 'policy-engine-v1'
      });
      continue;
    }

    const conditionMet = compare(metric.value, policy.condition);
    if (!conditionMet) {
      blocked.push(policy.policy_id);
      appendDecisionTrace({
        trace_id: deterministicUuid(`${policy.policy_id}:${now}:skip:condition`),
        correlation_id: correlationId,
        timestamp: now,
        policy_id: policy.policy_id,
        state_version: serviceState.version,
        target_service: policy.resource_scope.service,
        metrics_snapshot: { [metric.metric_name]: metric.value, [`${metric.aggregation}_window`]: metric.window_seconds },
        condition_result: false,
        action_decision: 'skip',
        action_parameters: { reason: 'condition_not_met' },
        confidence_score: 1.0,
        triggered_by: 'policy-engine-v1'
      });
      continue;
    }

    const runtimePolicy = state.policies[policy.policy_id] ?? { last_trigger_at: null, trigger_timestamps: [] };
    runtimePolicy.trigger_timestamps = pruneHistory(nowMs, runtimePolicy.trigger_timestamps, 60 * 60 * 1000);
    state.policies[policy.policy_id] = runtimePolicy;

    if (!killSwitch) {
      blocked.push(policy.policy_id);
      appendDecisionTrace({
        trace_id: deterministicUuid(`${policy.policy_id}:${now}:blocked:killswitch`),
        correlation_id: correlationId,
        timestamp: now,
        policy_id: policy.policy_id,
        state_version: serviceState.version,
        target_service: policy.resource_scope.service,
        metrics_snapshot: { [metric.metric_name]: metric.value, [`${metric.aggregation}_window`]: metric.window_seconds },
        condition_result: true,
        action_decision: 'blocked',
        action_parameters: { reason: 'kill_switch_disabled' },
        confidence_score: 1.0,
        triggered_by: 'policy-engine-v1'
      });
      continue;
    }

    if (runtimePolicy.last_trigger_at && nowMs - Date.parse(runtimePolicy.last_trigger_at) < policy.cool_down_seconds * 1000) {
      blocked.push(policy.policy_id);
      appendDecisionTrace({
        trace_id: deterministicUuid(`${policy.policy_id}:${now}:cooldown`),
        correlation_id: correlationId,
        timestamp: now,
        policy_id: policy.policy_id,
        state_version: serviceState.version,
        target_service: policy.resource_scope.service,
        metrics_snapshot: { [metric.metric_name]: metric.value, [`${metric.aggregation}_window`]: metric.window_seconds },
        condition_result: true,
        action_decision: 'cooldown',
        action_parameters: { reason: 'cooldown_active' },
        confidence_score: 1.0,
        triggered_by: 'policy-engine-v1'
      });
      incrementAuditMetric('policy_cooldown_active_total', 1, { policy_id: policy.policy_id });
      continue;
    }

    if (runtimePolicy.trigger_timestamps.length >= policy.max_triggers_per_hour) {
      blocked.push(policy.policy_id);
      appendDecisionTrace({
        trace_id: deterministicUuid(`${policy.policy_id}:${now}:blocked:hourly_cap`),
        correlation_id: correlationId,
        timestamp: now,
        policy_id: policy.policy_id,
        state_version: serviceState.version,
        target_service: policy.resource_scope.service,
        metrics_snapshot: { [metric.metric_name]: metric.value, [`${metric.aggregation}_window`]: metric.window_seconds },
        condition_result: true,
        action_decision: 'blocked',
        action_parameters: { reason: 'hourly_trigger_cap' },
        confidence_score: 1.0,
        triggered_by: 'policy-engine-v1'
      });
      continue;
    }

    if (state.intervention_timestamps.length >= GLOBAL_INTERVENTION_CAP_PER_HOUR) {
      blocked.push(policy.policy_id);
      appendDecisionTrace({
        trace_id: deterministicUuid(`${policy.policy_id}:${now}:blocked:global_cap`),
        correlation_id: correlationId,
        timestamp: now,
        policy_id: policy.policy_id,
        state_version: serviceState.version,
        target_service: policy.resource_scope.service,
        metrics_snapshot: { [metric.metric_name]: metric.value, [`${metric.aggregation}_window`]: metric.window_seconds },
        condition_result: true,
        action_decision: 'blocked',
        action_parameters: { reason: 'global_intervention_cap' },
        confidence_score: 1.0,
        triggered_by: 'policy-engine-v1'
      });
      continue;
    }

    let parameters: Record<string, string | number | boolean> = {};

    if (policy.action.type === 'scale_horizontal') {
      const history = state.scale_events[sKey] ?? [];
      state.scale_events[sKey] = history.filter((event) => nowMs - Date.parse(event.timestamp) <= 10 * 60 * 1000);
      const used = state.scale_events[sKey].reduce((sum, event) => sum + event.delta, 0);
      const available = Math.max(0, MAX_SCALE_PER_10_MIN - used);
      if (available <= 0) {
        blocked.push(policy.policy_id);
        continue;
      }
      const nextReplicas = Math.min(
        policy.action.max_replicas,
        Math.max(policy.action.min_replicas, serviceState.replicas + Math.min(policy.action.scale_step, available))
      );
      const delta = nextReplicas - serviceState.replicas;
      if (delta <= 0) {
        blocked.push(policy.policy_id);
        continue;
      }
      serviceState.replicas = nextReplicas;
      serviceState.last_scale_time = now;
      state.scale_events[sKey].push({ timestamp: now, delta });
      parameters = {
        desired_replicas: nextReplicas,
        reason: `cpu_p95_above_${policy.condition.threshold}_percent`
      };
    } else if (policy.action.type === 'traffic_shift') {
      const history = state.traffic_shift_events[sKey] ?? [];
      state.traffic_shift_events[sKey] = history.filter((event) => nowMs - Date.parse(event.timestamp) <= 60 * 60 * 1000);
      const used = state.traffic_shift_events[sKey].reduce((sum, event) => sum + event.shift, 0);
      const available = Math.max(0, MAX_TRAFFIC_SHIFT_PER_HOUR - used);
      if (available <= 0) {
        blocked.push(policy.policy_id);
        continue;
      }
      const shift = Math.min(policy.action.shift_percentage, available);
      state.traffic_shift_events[sKey].push({ timestamp: now, shift });
      parameters = {
        shift_percentage: shift,
        target_cluster: policy.action.target_cluster
      };
    } else {
      parameters = { max_parallel: policy.action.max_parallel };
    }

    serviceState.version += 1;
    serviceState.last_policy_trigger = policy.policy_id;
    serviceState.trigger_count_last_hour += 1;
    runtimePolicy.last_trigger_at = now;
    runtimePolicy.trigger_timestamps.push(now);
    state.intervention_timestamps.push(now);

    const commandBase = {
      command_id: deterministicUuid(`${policy.policy_id}:${sKey}:${serviceState.version}:${now}`),
      policy_id: policy.policy_id,
      target_service: policy.resource_scope.service,
      action: policy.action.type as PolicyActionType,
      parameters,
      issued_at: now,
      expires_at: new Date(nowMs + 5 * 60 * 1000).toISOString(),
      state_version: serviceState.version
    };

    const { hash, signature } = signPayload(commandBase);
    const command: SignedInterventionCommand = {
      ...commandBase,
      signature_input_hash: hash,
      signature: {
        algorithm: 'Ed25519',
        key_id: 'cp-root-key-01',
        signature
      }
    };

    triggered.push(policy.policy_id);
    commands.push(command);
    appendInterventionCommand(command);
    appendDecisionTrace({
      trace_id: deterministicUuid(`${policy.policy_id}:${now}:intervene`),
      correlation_id: correlationId,
      timestamp: now,
      policy_id: policy.policy_id,
      state_version: serviceState.version,
      target_service: policy.resource_scope.service,
      metrics_snapshot: { [metric.metric_name]: metric.value, [`${metric.aggregation}_window`]: metric.window_seconds },
      condition_result: true,
      action_decision: 'intervene',
      action_parameters: parameters,
      confidence_score: 1.0,
      triggered_by: 'policy-engine-v1'
    });
    incrementAuditMetric('policy_trigger_total', 1, { policy_id: policy.policy_id });
    incrementAuditMetric('intervention_signed_total', 1, { policy_id: policy.policy_id });
  }

  incrementAuditMetric('policy_evaluations_total', evaluatePoliciesSorted().length, { environment: request.environment });
  persistState(state);
  return {
    evaluated_at: now,
    triggered_policy_ids_in_order: triggered,
    blocked_policy_ids: blocked,
    signed_commands: commands,
    states: state.services
  };
}

export function getPolicyEngineState(environment: string, service: string): ServiceExecutionState | null {
  const state = loadState();
  return state.services[serviceKey(environment, service)] ?? null;
}
