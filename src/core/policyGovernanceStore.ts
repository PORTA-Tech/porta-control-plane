import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SignedInterventionCommand } from './policyExecutionEngine.js';

export type DecisionAction = 'intervene' | 'skip' | 'cooldown' | 'blocked';

export interface DecisionTrace {
  trace_id: string;
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

const tracesPath = path.resolve('.data', 'audit-decision-traces.ndjson');
const commandsPath = path.resolve('.data', 'signed-intervention-commands.ndjson');
const metricsPath = path.resolve('.data', 'audit-observability-metrics.json');
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
  | 'audit_signature_verification_total';

interface MetricRecord {
  metric_name: MetricName;
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
