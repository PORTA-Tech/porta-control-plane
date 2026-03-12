import { appendOperatorAuditEvent } from './operatorAudit.js';
import { persistRuntimeState, runtimeState } from '../store/runtimeState.js';

export interface RolloutValidationGateReport {
  gateId: string;
  name: string;
  success: boolean;
  detail: string;
  checkedAtUtc: string;
}

export interface RolloutValidationReport {
  suiteName: string;
  machineId: string;
  deviceId: string | null;
  accountId: string | null;
  orgId: string | null;
  generatedAtUtc: string;
  expiresAtUtc: string | null;
  updatedAtUtc: string;
  passed: boolean;
  gates: RolloutValidationGateReport[];
}

export interface RolloutValidationReportInput {
  suiteName?: unknown;
  machineId?: unknown;
  deviceId?: unknown;
  accountId?: unknown;
  orgId?: unknown;
  generatedAtUtc?: unknown;
  expiresAtUtc?: unknown;
  passed?: unknown;
  gates?: unknown;
}

export class RolloutValidationError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function normalizeNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RolloutValidationError(400, 'VALIDATION_ERROR', `${fieldName} is required.`);
  }

  return value.trim();
}

function normalizeNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new RolloutValidationError(400, 'VALIDATION_ERROR', 'Optional string fields must be strings when present.');
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTimestamp(value: unknown, fieldName: string): string {
  const normalized = normalizeNonEmptyString(value, fieldName);
  if (!isValidTimestamp(normalized)) {
    throw new RolloutValidationError(400, 'VALIDATION_ERROR', `${fieldName} must be an ISO-8601 timestamp.`);
  }

  return new Date(normalized).toISOString();
}

function normalizeOptionalTimestamp(value: unknown, fieldName: string): string | null {
  const normalized = normalizeNullableString(value);
  if (normalized === null) {
    return null;
  }

  if (!isValidTimestamp(normalized)) {
    throw new RolloutValidationError(400, 'VALIDATION_ERROR', `${fieldName} must be an ISO-8601 timestamp.`);
  }

  return new Date(normalized).toISOString();
}

function normalizeGate(raw: unknown): RolloutValidationGateReport {
  if (!isRecord(raw)) {
    throw new RolloutValidationError(400, 'VALIDATION_ERROR', 'Each validation gate must be an object.');
  }

  if (typeof raw.success !== 'boolean') {
    throw new RolloutValidationError(400, 'VALIDATION_ERROR', 'Each validation gate must include a boolean success value.');
  }

  return {
    gateId: normalizeNonEmptyString(raw.gateId, 'gateId'),
    name: normalizeNonEmptyString(raw.name, 'name'),
    success: raw.success,
    detail: normalizeNonEmptyString(raw.detail, 'detail'),
    checkedAtUtc: normalizeTimestamp(raw.checkedAtUtc, 'checkedAtUtc')
  };
}

function normalizeReport(input: RolloutValidationReportInput, updatedAtUtc: string): RolloutValidationReport {
  const gatesRaw = Array.isArray(input.gates) ? input.gates : null;
  if (!gatesRaw || gatesRaw.length === 0) {
    throw new RolloutValidationError(400, 'VALIDATION_ERROR', 'gates must contain at least one gate result.');
  }

  const gates = gatesRaw.map(normalizeGate);
  const derivedPassed = gates.every((gate) => gate.success);
  if (typeof input.passed === 'boolean' && input.passed !== derivedPassed) {
    throw new RolloutValidationError(400, 'VALIDATION_ERROR', 'passed must match the submitted gate results.');
  }

  return {
    suiteName: normalizeNonEmptyString(input.suiteName, 'suiteName'),
    machineId: normalizeNonEmptyString(input.machineId, 'machineId'),
    deviceId: normalizeNullableString(input.deviceId),
    accountId: normalizeNullableString(input.accountId),
    orgId: normalizeNullableString(input.orgId),
    generatedAtUtc: normalizeTimestamp(input.generatedAtUtc, 'generatedAtUtc'),
    expiresAtUtc: normalizeOptionalTimestamp(input.expiresAtUtc, 'expiresAtUtc'),
    updatedAtUtc,
    passed: derivedPassed,
    gates
  };
}

export function readRolloutValidationReport(): RolloutValidationReport | null {
  if (!isRecord(runtimeState.rolloutValidationReport)) {
    return null;
  }

  try {
    const raw = runtimeState.rolloutValidationReport;
    return normalizeReport(raw as RolloutValidationReportInput, normalizeTimestamp(raw.updatedAtUtc, 'updatedAtUtc'));
  } catch {
    return null;
  }
}

export function upsertRolloutValidationReport(input: RolloutValidationReportInput, actorId: string): RolloutValidationReport {
  const report = normalizeReport(input, new Date().toISOString());
  runtimeState.rolloutValidationReport = report;
  persistRuntimeState();
  appendOperatorAuditEvent(actorId, 'rollout.validation_report_updated', 'rollout_validation_store', {
    suiteName: report.suiteName,
    machineId: report.machineId,
    deviceId: report.deviceId,
    accountId: report.accountId,
    orgId: report.orgId,
    passed: report.passed,
    gateCount: report.gates.length,
    failedGateCount: report.gates.filter((gate) => !gate.success).length
  });
  return report;
}

export function clearRolloutValidationReportForTests(): void {
  runtimeState.rolloutValidationReport = undefined;
}
