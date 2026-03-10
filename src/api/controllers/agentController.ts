import { Router } from 'express';
import type { MachineActionEvent, MachineSummaryReport } from '@porta/api-contracts';
import { runtimeState } from '../../store/runtimeState.js';
import { listAgentPresence, upsertAgentPresence, upsertPresenceFromTelemetryBatch } from '../../store/agentPresenceStore.js';
import { appendMachineActionEvent } from '../../store/machineActionStore.js';
import { upsertMachineSummary } from '../../store/machineSummaryStore.js';

interface AgentStatusPayload {
  agentId?: string;
  timestampUtc?: string;
  note?: string;
  status?: unknown;
  control?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isMachineSummaryReport(value: unknown): value is MachineSummaryReport {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const row = value as Record<string, unknown>;
  return (
    isNonEmptyString(row.machineId) &&
    isNonEmptyString(row.machineName) &&
    isNonEmptyString(row.userName) &&
    isNonEmptyString(row.agentVersion) &&
    isNonEmptyString(row.schemaVersion) &&
    isNonEmptyString(row.policyVersion) &&
    isNonEmptyString(row.reportedAtUtc) &&
    isBoolean(row.agentRunning) &&
    isBoolean(row.userSessionConnected) &&
    isBoolean(row.activityDetected) &&
    isOptionalString(row.lastActivityUtc) &&
    isOptionalString(row.userAgentHeartbeatUtc) &&
    isNonEmptyString(row.captureContext) &&
    isBoolean(row.keyboardSignalActive) &&
    isBoolean(row.mouseSignalActive) &&
    isOptionalString(row.ownershipWarning) &&
    isOptionalString(row.captureFailureReason) &&
    isOptionalString(row.lastError) &&
    isBoolean(row.backendConnected) &&
    isBoolean(row.localApiAuthReady) &&
    isBoolean(row.dbMigrationFailed) &&
    isFiniteNumber(row.taskContinuityScore) &&
    isFiniteNumber(row.taskContinuitySeconds) &&
    isNonEmptyString(row.continuityState) &&
    isBoolean(row.deepWorkActive) &&
    isFiniteNumber(row.overloadLikelihood) &&
    isBoolean(row.overloadActive) &&
    isBoolean(row.breakNeeded) &&
    isOptionalString(row.breakPendingAction) &&
    isOptionalString(row.breakPendingReasonCode) &&
    isNonEmptyString(row.calibrationStage) &&
    isNonEmptyString(row.trustTier) &&
    isFiniteNumber(row.modelConfidence) &&
    (row.signalQualityScore === null || row.signalQualityScore === undefined || isFiniteNumber(row.signalQualityScore)) &&
    isBoolean(row.partialData) &&
    isStringArray(row.missingMajorChannels)
  );
}

function isMachineActionEvent(value: unknown): value is MachineActionEvent {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const row = value as Record<string, unknown>;
  return (
    isNonEmptyString(row.machineId) &&
    isNonEmptyString(row.userName) &&
    isNonEmptyString(row.interventionId) &&
    isNonEmptyString(row.action) &&
    isNonEmptyString(row.actionCategory) &&
    isNonEmptyString(row.decisionState) &&
    isNonEmptyString(row.executionState) &&
    isNonEmptyString(row.verifiedState) &&
    isNonEmptyString(row.timestampUtc) &&
    isOptionalString(row.appliedAtUtc) &&
    isOptionalString(row.errorCode) &&
    isNonEmptyString(row.policyId) &&
    isOptionalString(row.whatChanged) &&
    isOptionalString(row.howToUndo)
  );
}

export function createAgentController(): Router {
  const router = Router();

  router.post('/heartbeat', (req, res) => {
    const payload = (req.body ?? {}) as AgentStatusPayload;
    const agentId = typeof payload.agentId === 'string' && payload.agentId.trim().length > 0 ? payload.agentId.trim() : undefined;

    if (!agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }

    const record = upsertAgentPresence(payload);
    if (!record) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }

    res.status(202).json({
      accepted: true,
      agentId,
      heartbeatCount: record.heartbeatCount,
      config_seq: runtimeState.currentConfigSeq,
      config_version: runtimeState.currentConfigVersion,
      signature_validity: runtimeState.currentConfigSignatureValid ?? false,
      applied_at_utc: runtimeState.appliedAtUtc
    });
  });

  router.post('/telemetry', (req, res) => {
    const batch = Array.isArray(req.body) ? req.body : [];
    upsertPresenceFromTelemetryBatch(batch);
    res.status(202).json({ accepted: true, count: batch.length });
  });

  router.post('/machine-summary', async (req, res, next) => {
    try {
      const payload = req.body;
      if (!isMachineSummaryReport(payload)) {
        res.status(400).json({ error: 'invalid machine summary payload' });
        return;
      }

      await upsertMachineSummary(payload);
      res.status(202).json({ accepted: true, machineId: payload.machineId, reportedAtUtc: payload.reportedAtUtc });
    } catch (error) {
      next(error);
    }
  });

  router.post('/action-events', async (req, res, next) => {
    try {
      const payload = Array.isArray(req.body) ? req.body : [];
      if (!payload.every(isMachineActionEvent)) {
        res.status(400).json({ error: 'invalid machine action event payload' });
        return;
      }

      for (const event of payload) {
        await appendMachineActionEvent(event);
      }

      res.status(202).json({ accepted: true, count: payload.length });
    } catch (error) {
      next(error);
    }
  });

  // Simple diagnostic endpoint for local validation.
  router.get('/presence', (_req, res) => {
    res.json(listAgentPresence());
  });

  return router;
}
