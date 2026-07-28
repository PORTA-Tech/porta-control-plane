import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SignedInterventionCommand } from './policyExecutionEngine.js';

export type DecisionAction = 'intervene' | 'skip' | 'cooldown' | 'blocked';

export interface DecisionTrace {
  trace_id: string;
  correlation_id: string;
  timestamp: string;
  policy_id: string;
  state_version: number;
  target_service: string;
  metrics_snapshot: Record<string, string | number | boolean>;
  condition_result: boolean;
  action_decision: DecisionAction;
  action_parameters: Record<string, string | number | boolean>;
  confidence_score: number;
  triggered_by: string;
  signature: {
    algorithm: 'Ed25519';
    key_id: 'cp-root-key-01';
    signature: string;
  };
}

export interface ReplayVerificationResult {
  trace_id: string;
  result: 'match' | 'mismatch';
  differences: Array<{ field_name: string; expected_value: unknown; actual_value: unknown }>;
  signature_verification: 'verified' | 'invalid';
}

export interface AlertRecord {
  alert_id: string;
  alert_type:
    | 'high_stress_probability'
    | 'overload_probability'
    | 'intervention_failure'
    | 'policy_version_mismatch'
    | 'signature_verification_failure'
    | 'latency_breach';
  severity: 'warning' | 'critical';
  status: 'active' | 'resolved';
  first_seen_at: string;
  last_seen_at: string;
  target_service: string;
  correlation_id: string;
  threshold: string;
  reason: string;
}

const tracesPath = path.resolve('.data', 'audit-decision-traces.ndjson');
const commandsPath = path.resolve('.data', 'signed-intervention-commands.ndjson');
const metricsPath = path.resolve('.data', 'audit-observability-metrics.json');
const alertsPath = path.resolve('.data', 'audit-alerts.ndjson');
const privateKeyPath = path.resolve('signer-private.pem');
const publicKeyPath = path.resolve('signer-public.pem');
const defaultPrivateKeyPem = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIP9JxHB5GacOrYlIguz6uyrlrGVmXNi3uCtAGqKstxP2
-----END PRIVATE KEY-----
`;
const defaultPublicKeyPem = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAh55FcXC93q/jqMJ2XVjy+qqtU1+EEG1zB0ELsX9dhXs=
-----END PUBLIC KEY-----
`;

function ensureDir(): void {
  fs.mkdirSync(path.resolve('.data'), { recursive: true });
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

function signObject(payload: unknown): string {
  const canonical = canonicalize(payload);
  const hash = crypto.createHash('sha256').update(canonical).digest('hex');
  const privateKey =
    process.env.CONTROL_PLANE_SIGNING_PRIVATE_KEY_PEM ||
    (fs.existsSync(privateKeyPath) ? fs.readFileSync(privateKeyPath, 'utf8') : defaultPrivateKeyPem);
  return crypto.sign(null, Buffer.from(hash, 'utf8'), privateKey).toString('base64');
}

function verifySignature(payload: unknown, signature: string): boolean {
  const canonical = canonicalize(payload);
  const hash = crypto.createHash('sha256').update(canonical).digest('hex');
  const publicKey =
    process.env.CONTROL_PLANE_SIGNING_PUBLIC_KEY_PEM ||
    (fs.existsSync(publicKeyPath) ? fs.readFileSync(publicKeyPath, 'utf8') : defaultPublicKeyPem);
  try {
    return crypto.verify(null, Buffer.from(hash, 'utf8'), publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

function deterministicId(seed: string): string {
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24);
}

export function appendDecisionTrace(input: Omit<DecisionTrace, 'signature'>): DecisionTrace {
  ensureDir();
  const signature = signObject(input);
  const trace: DecisionTrace = {
    ...input,
    signature: {
      algorithm: 'Ed25519',
      key_id: 'cp-root-key-01',
      signature
    }
  };
  fs.appendFileSync(tracesPath, `${JSON.stringify(trace)}\n`);
  incrementAuditMetric('audit_traces_written_total', 1, { target_service: trace.target_service });
  incrementAuditMetric('correlation_trace_complete_total', trace.correlation_id ? 1 : 0, { target_service: trace.target_service });
  incrementAuditMetric('correlation_trace_incomplete_total', trace.correlation_id ? 0 : 1, { target_service: trace.target_service });
  evaluateAlertsForTrace(trace);
  return trace;
}

export function appendInterventionCommand(command: SignedInterventionCommand): void {
  ensureDir();
  fs.appendFileSync(commandsPath, `${JSON.stringify(command)}\n`);
}

export function readDecisionTraces(limit = 200): DecisionTrace[] {
  if (!fs.existsSync(tracesPath)) {
    return [];
  }
  const lines = fs
    .readFileSync(tracesPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines
    .map((line) => JSON.parse(line) as DecisionTrace)
    .slice(Math.max(0, lines.length - Math.max(1, limit)));
}

export function readInterventionCommands(limit = 200): SignedInterventionCommand[] {
  if (!fs.existsSync(commandsPath)) {
    return [];
  }
  const lines = fs
    .readFileSync(commandsPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines
    .map((line) => JSON.parse(line) as SignedInterventionCommand)
    .slice(Math.max(0, lines.length - Math.max(1, limit)));
}

export function replayDecisionTrace(traceId: string): ReplayVerificationResult {
  const trace = readDecisionTraces(10_000).find((item) => item.trace_id === traceId);
  if (!trace) {
    return {
      trace_id: traceId,
      result: 'mismatch',
      differences: [{ field_name: 'trace_id', expected_value: 'existing_trace', actual_value: 'missing' }],
      signature_verification: 'invalid'
    };
  }

  const unsigned = { ...trace };
  delete (unsigned as { signature?: DecisionTrace['signature'] }).signature;
  const signatureOk = verifySignature(unsigned, trace.signature.signature);

  const expectedDecision: DecisionAction = trace.condition_result ? 'intervene' : 'skip';
  const differences: Array<{ field_name: string; expected_value: unknown; actual_value: unknown }> = [];
  if (trace.action_decision !== expectedDecision && trace.action_decision !== 'cooldown' && trace.action_decision !== 'blocked') {
    differences.push({
      field_name: 'action_decision',
      expected_value: expectedDecision,
      actual_value: trace.action_decision
    });
  }

  const result: 'match' | 'mismatch' = differences.length === 0 && signatureOk ? 'match' : 'mismatch';
  if (result === 'mismatch') {
    incrementAuditMetric('audit_replay_mismatch_total', 1, { trace_id: trace.trace_id });
  }

  incrementAuditMetric('audit_signature_verification_total', 1, { result: signatureOk ? 'verified' : 'invalid' });
  if (!signatureOk) {
    appendOrUpdateAlert({
      alert_id: deterministicId(`sig:${trace.trace_id}`),
      alert_type: 'signature_verification_failure',
      severity: 'critical',
      status: 'active',
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      target_service: trace.target_service,
      correlation_id: trace.correlation_id,
      threshold: 'signature_valid=true',
      reason: 'Invalid Ed25519 signature during replay verification'
    });
  }
  return {
    trace_id: trace.trace_id,
    result,
    differences,
    signature_verification: signatureOk ? 'verified' : 'invalid'
  };
}

type MetricName =
  | 'policy_evaluations_total'
  | 'policy_trigger_total'
  | 'intervention_signed_total'
  | 'intervention_rejected_total'
  | 'policy_cooldown_active_total'
  | 'state_conflict_retries_total'
  | 'audit_traces_written_total'
  | 'audit_traces_failed_total'
  | 'audit_access_denied_total'
  | 'audit_replay_mismatch_total'
  | 'audit_signature_verification_total'
  | 'correlation_trace_complete_total'
  | 'correlation_trace_incomplete_total'
  | 'alerts_triggered_total'
  // Machine summaries accepted as anonymous inventory because the caller proved no device
  // credential. This is the counter that tells you whether the fleet is ready for enforce.
  | 'agent_machine_summary_anonymous_total'
  // A device asked about an account it is not linked to, or proved no device at all. In log
  // mode these are allowed through and counted; in enforce mode they are refused.
  | 'agent_device_account_mismatch_total';

interface MetricRecord {
  metric_name: string;
  value: number;
  labels: Record<string, string>;
}

export function incrementAuditMetric(metricName: MetricName, amount: number, labels: Record<string, string>): void {
  ensureDir();
  const current = fs.existsSync(metricsPath)
    ? (JSON.parse(fs.readFileSync(metricsPath, 'utf8')) as MetricRecord[])
    : [];
  const key = `${metricName}:${canonicalize(labels)}`;
  const idx = current.findIndex((item) => `${item.metric_name}:${canonicalize(item.labels)}` === key);
  if (idx >= 0) {
    const existing = current[idx];
    if (existing) {
      existing.value += amount;
    }
  } else {
    current.push({ metric_name: metricName, value: amount, labels });
  }
  fs.writeFileSync(metricsPath, JSON.stringify(current, null, 2));
}

export function readAuditMetrics(): MetricRecord[] {
  if (!fs.existsSync(metricsPath)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(metricsPath, 'utf8')) as MetricRecord[];
}

export function readAlertHistory(limit = 500): AlertRecord[] {
  if (!fs.existsSync(alertsPath)) {
    return [];
  }

  const lines = fs
    .readFileSync(alertsPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines
    .map((line) => JSON.parse(line) as AlertRecord)
    .slice(Math.max(0, lines.length - Math.max(1, limit)));
}

export function readActiveAlerts(limit = 200): AlertRecord[] {
  const latestById = new Map<string, AlertRecord>();
  for (const alert of readAlertHistory(5000)) {
    latestById.set(alert.alert_id, alert);
  }

  return [...latestById.values()]
    .filter((item) => item.status === 'active')
    .sort((a, b) => Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at))
    .slice(0, Math.max(1, limit));
}

export function resolveAlert(alertId: string): AlertRecord | null {
  const active = readActiveAlerts(5000).find((item) => item.alert_id === alertId);
  if (!active) {
    return null;
  }

  const resolved: AlertRecord = {
    ...active,
    status: 'resolved',
    last_seen_at: new Date().toISOString()
  };
  fs.appendFileSync(alertsPath, `${JSON.stringify(resolved)}\n`);
  return resolved;
}

function evaluateAlertsForTrace(trace: DecisionTrace): void {
  const nowMs = Date.parse(trace.timestamp);
  const recent = readDecisionTraces(500).filter((item) => nowMs - Date.parse(item.timestamp) <= 5 * 60 * 1000);
  const stressBreaches = recent.filter((item) => Number(item.metrics_snapshot.stress_likelihood ?? 0) > 0.9);
  const overloadBreaches = recent.filter((item) => Number(item.metrics_snapshot.overload_likelihood ?? 0) > 0.85);
  const interventionFailures = recent.filter(
    (item) =>
      item.action_decision === 'blocked' &&
      String(item.action_parameters.reason ?? '').toLowerCase().includes('intervention')
  );
  const policyVersionMismatches = recent.filter((item) =>
    String(item.action_parameters.reason ?? '').toLowerCase().includes('policy_version_mismatch')
  );
  const latencyBreaches = recent.filter((item) => Number(item.metrics_snapshot.event_to_console_ms ?? 0) > 2000);

  if (stressBreaches.length > 0) {
    const spanSec = (Date.parse(stressBreaches[stressBreaches.length - 1]!.timestamp) - Date.parse(stressBreaches[0]!.timestamp)) / 1000;
    if (spanSec >= 30) {
      appendOrUpdateAlert({
        alert_id: deterministicId(`stress:${trace.target_service}`),
        alert_type: 'high_stress_probability',
        severity: 'critical',
        status: 'active',
        first_seen_at: stressBreaches[0]!.timestamp,
        last_seen_at: stressBreaches[stressBreaches.length - 1]!.timestamp,
        target_service: trace.target_service,
        correlation_id: trace.correlation_id,
        threshold: 'stress_likelihood > 0.9 for >30s',
        reason: 'Sustained stress probability breach'
      });
    }
  }

  if (overloadBreaches.length > 0) {
    const spanSec = (Date.parse(overloadBreaches[overloadBreaches.length - 1]!.timestamp) - Date.parse(overloadBreaches[0]!.timestamp)) / 1000;
    if (spanSec >= 60) {
      appendOrUpdateAlert({
        alert_id: deterministicId(`overload:${trace.target_service}`),
        alert_type: 'overload_probability',
        severity: 'warning',
        status: 'active',
        first_seen_at: overloadBreaches[0]!.timestamp,
        last_seen_at: overloadBreaches[overloadBreaches.length - 1]!.timestamp,
        target_service: trace.target_service,
        correlation_id: trace.correlation_id,
        threshold: 'overload_likelihood > 0.85 for >60s',
        reason: 'Sustained overload probability breach'
      });
    }
  }

  if (interventionFailures.length > 3) {
    appendOrUpdateAlert({
      alert_id: deterministicId(`intervention-failure:${trace.target_service}`),
      alert_type: 'intervention_failure',
      severity: 'critical',
      status: 'active',
      first_seen_at: interventionFailures[0]!.timestamp,
      last_seen_at: interventionFailures[interventionFailures.length - 1]!.timestamp,
      target_service: trace.target_service,
      correlation_id: trace.correlation_id,
      threshold: 'failed interventions > 3 in 5m',
      reason: 'Repeated intervention failures detected'
    });
  }

  if (policyVersionMismatches.length > 0) {
    appendOrUpdateAlert({
      alert_id: deterministicId(`policy-version:${trace.target_service}`),
      alert_type: 'policy_version_mismatch',
      severity: 'warning',
      status: 'active',
      first_seen_at: policyVersionMismatches[0]!.timestamp,
      last_seen_at: policyVersionMismatches[policyVersionMismatches.length - 1]!.timestamp,
      target_service: trace.target_service,
      correlation_id: trace.correlation_id,
      threshold: 'agent policy version == control-plane latest',
      reason: 'Policy version mismatch observed'
    });
  }

  if (latencyBreaches.length > 0) {
    appendOrUpdateAlert({
      alert_id: deterministicId(`latency:${trace.target_service}`),
      alert_type: 'latency_breach',
      severity: 'warning',
      status: 'active',
      first_seen_at: latencyBreaches[0]!.timestamp,
      last_seen_at: latencyBreaches[latencyBreaches.length - 1]!.timestamp,
      target_service: trace.target_service,
      correlation_id: trace.correlation_id,
      threshold: 'event->console latency > 2s',
      reason: 'End-to-end latency threshold breached'
    });
  }
}

function appendOrUpdateAlert(alert: AlertRecord): void {
  ensureDir();
  const active = readActiveAlerts(5000).find((item) => item.alert_id === alert.alert_id);
  if (active) {
    const updated: AlertRecord = {
      ...active,
      status: 'active',
      last_seen_at: alert.last_seen_at,
      correlation_id: alert.correlation_id,
      reason: alert.reason
    };
    fs.appendFileSync(alertsPath, `${JSON.stringify(updated)}\n`);
    return;
  }

  fs.appendFileSync(alertsPath, `${JSON.stringify(alert)}\n`);
  incrementAuditMetric('alerts_triggered_total', 1, { alert_type: alert.alert_type, severity: alert.severity });
}
