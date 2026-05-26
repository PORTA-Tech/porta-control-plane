import { Router } from 'express';
import type { MachineActionEvent, MachineSummaryReport } from '@porta/api-contracts';
import { runtimeState } from '../../store/runtimeState.js';
import { listAgentPresence, upsertAgentPresence, upsertPresenceFromTelemetryBatch } from '../../store/agentPresenceStore.js';
import { appendMachineActionEvent } from '../../store/machineActionStore.js';
import { upsertMachineSummary, withCanonicalMachineSummary } from '../../store/machineSummaryStore.js';
import { maybeActivateAccount, recordAccountActiveDay } from '../../core/growthService.js';
import { reconcileDeviceProfileFromTelemetry } from '../../core/identityProfileService.js';
import { getAccountProfile } from '../../store/accountStore.js';
import { buildDigestEmail, type DailyDigestPayload } from '../../core/digestEmailBuilder.js';
import { sendEmail } from '../../core/emailService.js';

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

function normalizeOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeContinuityState(value: unknown): MachineSummaryReport['continuityState'] | null {
  if (!isNonEmptyString(value)) {
    return null;
  }

  switch (value.trim().toLowerCase()) {
    case 'keep':
      return 'keep';
    case 'pause':
      return 'pause';
    case 'decay':
      return 'decay';
    case 'reset':
      return 'reset';
    default:
      return null;
  }
}

function normalizeAttentionSegmentKind(value: unknown): MachineSummaryReport['attentionSegmentKind'] | null {
  if (!isNonEmptyString(value)) {
    return null;
  }

  switch (value.trim().toLowerCase()) {
    case 'focus':
      return 'focus';
    case 'context_excursion':
      return 'context_excursion';
    case 'off_task_distraction':
      return 'off_task_distraction';
    case 'fragmentation_distraction':
      return 'fragmentation_distraction';
    case 'away':
      return 'away';
    default:
      return null;
  }
}

function normalizeBreakKind(value: unknown): MachineSummaryReport['breakPendingKind'] | null {
  if (!isNonEmptyString(value)) {
    return null;
  }

  switch (value.trim().toLowerCase()) {
    case 'short_break':
    case 'stretch_break_suggestion':
      return 'short_break';
    case 'long_break':
    case 'break_suggestion':
      return 'long_break';
    default:
      return null;
  }
}

function normalizeMachineSummaryReport(value: unknown): MachineSummaryReport | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const row = value as Record<string, unknown>;
  const focusEpisodeQuality = isFiniteNumber(row.focusEpisodeQuality)
    ? row.focusEpisodeQuality
    : (isFiniteNumber(row.taskContinuityScore) ? row.taskContinuityScore : null);
  const focusEpisodeSeconds = isFiniteNumber(row.focusEpisodeSeconds)
    ? row.focusEpisodeSeconds
    : (isFiniteNumber(row.taskContinuitySeconds) ? row.taskContinuitySeconds : null);
  const pressureLevel = isFiniteNumber(row.pressureLevel)
    ? row.pressureLevel
    : (isFiniteNumber(row.overloadLikelihood) ? row.overloadLikelihood : null);
  const pressureConfidence = isFiniteNumber(row.pressureConfidence)
    ? row.pressureConfidence
    : (isFiniteNumber(row.modelConfidence) ? row.modelConfidence : null);
  const breakPendingKind = normalizeBreakKind(row.breakPendingKind ?? row.breakPendingAction);
  const focusEpisodeState = normalizeContinuityState(row.focusEpisodeState ?? row.continuityState);
  const attentionSegmentKind = normalizeAttentionSegmentKind(row.attentionSegmentKind) ?? 'focus';
  const attentionSegmentSeconds = isFiniteNumber(row.attentionSegmentSeconds) ? row.attentionSegmentSeconds : 0;
  const distractionEpisodeActive = isBoolean(row.distractionEpisodeActive)
    ? row.distractionEpisodeActive
    : (attentionSegmentKind === 'off_task_distraction' || attentionSegmentKind === 'fragmentation_distraction');
  const distractionEpisodeSeconds = isFiniteNumber(row.distractionEpisodeSeconds)
    ? row.distractionEpisodeSeconds
    : (distractionEpisodeActive ? attentionSegmentSeconds : 0);
  if (
    !(
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
      (row.userAgentHeartbeatAgeSeconds === null || row.userAgentHeartbeatAgeSeconds === undefined || isFiniteNumber(row.userAgentHeartbeatAgeSeconds)) &&
      (row.lastAcceptedInputAgeSeconds === null || row.lastAcceptedInputAgeSeconds === undefined || isFiniteNumber(row.lastAcceptedInputAgeSeconds)) &&
      isOptionalString(row.userAgentStartupSource) &&
      isOptionalString(row.userAgentStartupState) &&
      isOptionalString(row.userAgentLastLaunchReason) &&
      (row.userAgentHeartbeatWriteFailureCount === null || row.userAgentHeartbeatWriteFailureCount === undefined || isFiniteNumber(row.userAgentHeartbeatWriteFailureCount)) &&
      isNonEmptyString(row.captureContext) &&
      isBoolean(row.keyboardSignalActive) &&
      isBoolean(row.mouseSignalActive) &&
      isOptionalString(row.ownershipWarning) &&
      isOptionalString(row.captureFailureReason) &&
      isOptionalString(row.lastError) &&
      isBoolean(row.backendConnected) &&
      isBoolean(row.localApiAuthReady) &&
      isBoolean(row.dbMigrationFailed) &&
      focusEpisodeQuality !== null &&
      focusEpisodeSeconds !== null &&
      focusEpisodeState !== null &&
      isOptionalString(row.focusEpisodeReasonCode) &&
      isOptionalString(row.focusEpisodeReasonText) &&
      isOptionalString(row.attentionSegmentReasonCode) &&
      isOptionalString(row.attentionSegmentReasonText) &&
      isBoolean(row.deepWorkActive) &&
      pressureLevel !== null &&
      pressureConfidence !== null &&
      (row.overloadLikelihood === null || row.overloadLikelihood === undefined || isFiniteNumber(row.overloadLikelihood)) &&
      isBoolean(row.overloadActive) &&
      isBoolean(row.breakNeeded) &&
      isOptionalString(row.breakPendingKind) &&
      isOptionalString(row.breakPendingAction) &&
      isOptionalString(row.breakPendingReasonCode) &&
      isNonEmptyString(row.calibrationStage) &&
      isNonEmptyString(row.trustTier) &&
      isFiniteNumber(row.modelConfidence) &&
      (row.signalQualityScore === null || row.signalQualityScore === undefined || isFiniteNumber(row.signalQualityScore)) &&
      isBoolean(row.partialData) &&
      isStringArray(row.missingMajorChannels)
    )
  ) {
    return null;
  }

  return withCanonicalMachineSummary({
    deviceId: normalizeOptionalString(row.deviceId) ?? undefined,
    accountId: normalizeOptionalString(row.accountId) ?? undefined,
    orgId: normalizeOptionalString(row.orgId) ?? undefined,
    machineId: row.machineId.trim(),
    machineName: row.machineName.trim(),
    userName: row.userName.trim(),
    agentVersion: row.agentVersion.trim(),
    schemaVersion: row.schemaVersion.trim(),
    policyVersion: row.policyVersion.trim(),
    reportedAtUtc: row.reportedAtUtc.trim(),
    agentRunning: row.agentRunning,
    userSessionConnected: row.userSessionConnected,
    activityDetected: row.activityDetected,
    lastActivityUtc: normalizeOptionalString(row.lastActivityUtc) ?? undefined,
    userAgentHeartbeatUtc: normalizeOptionalString(row.userAgentHeartbeatUtc) ?? undefined,
    userAgentHeartbeatAgeSeconds: isFiniteNumber(row.userAgentHeartbeatAgeSeconds) ? row.userAgentHeartbeatAgeSeconds : (row.userAgentHeartbeatAgeSeconds ?? undefined),
    lastAcceptedInputAgeSeconds: isFiniteNumber(row.lastAcceptedInputAgeSeconds) ? row.lastAcceptedInputAgeSeconds : (row.lastAcceptedInputAgeSeconds ?? undefined),
    userAgentStartupSource: normalizeOptionalString(row.userAgentStartupSource) ?? undefined,
    userAgentStartupState: normalizeOptionalString(row.userAgentStartupState) ?? undefined,
    userAgentLastLaunchReason: normalizeOptionalString(row.userAgentLastLaunchReason) ?? undefined,
    userAgentHeartbeatWriteFailureCount: isFiniteNumber(row.userAgentHeartbeatWriteFailureCount) ? row.userAgentHeartbeatWriteFailureCount : (row.userAgentHeartbeatWriteFailureCount ?? undefined),
    captureContext: row.captureContext.trim() as MachineSummaryReport['captureContext'],
    keyboardSignalActive: row.keyboardSignalActive,
    mouseSignalActive: row.mouseSignalActive,
    ownershipWarning: normalizeOptionalString(row.ownershipWarning) ?? undefined,
    captureFailureReason: normalizeOptionalString(row.captureFailureReason) ?? undefined,
    lastError: normalizeOptionalString(row.lastError) ?? undefined,
    backendConnected: row.backendConnected,
    localApiAuthReady: row.localApiAuthReady,
    dbMigrationFailed: row.dbMigrationFailed,
    focusEpisodeQuality,
    focusEpisodeSeconds,
    focusEpisodeState,
    focusEpisodeReasonCode: normalizeOptionalString(row.focusEpisodeReasonCode) ?? undefined,
    focusEpisodeReasonText: normalizeOptionalString(row.focusEpisodeReasonText) ?? undefined,
    attentionSegmentKind,
    attentionSegmentSeconds,
    attentionSegmentReasonCode: normalizeOptionalString(row.attentionSegmentReasonCode) ?? undefined,
    attentionSegmentReasonText: normalizeOptionalString(row.attentionSegmentReasonText) ?? undefined,
    distractionEpisodeActive,
    distractionEpisodeSeconds,
    pressureLevel,
    pressureConfidence,
    taskContinuityScore: isFiniteNumber(row.taskContinuityScore) ? row.taskContinuityScore : focusEpisodeQuality,
    taskContinuitySeconds: isFiniteNumber(row.taskContinuitySeconds) ? row.taskContinuitySeconds : focusEpisodeSeconds,
    continuityState: normalizeContinuityState(row.continuityState) ?? focusEpisodeState,
    deepWorkActive: row.deepWorkActive,
    overloadLikelihood: isFiniteNumber(row.overloadLikelihood) ? row.overloadLikelihood : pressureLevel,
    overloadActive: row.overloadActive,
    breakNeeded: row.breakNeeded,
    breakPendingKind: breakPendingKind ?? undefined,
    breakPendingAction: normalizeOptionalString(row.breakPendingAction) ?? undefined,
    breakPendingReasonCode: normalizeOptionalString(row.breakPendingReasonCode) ?? undefined,
    calibrationStage: row.calibrationStage.trim() as MachineSummaryReport['calibrationStage'],
    trustTier: row.trustTier.trim() as MachineSummaryReport['trustTier'],
    modelConfidence: row.modelConfidence,
    signalQualityScore: isFiniteNumber(row.signalQualityScore) ? row.signalQualityScore : (row.signalQualityScore ?? undefined),
    partialData: row.partialData,
    missingMajorChannels: [...row.missingMajorChannels]
  } as MachineSummaryReport);
}

function isMachineActionEvent(value: unknown): value is MachineActionEvent {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const row = value as Record<string, unknown>;
  // Compatibility validation:
  // action may still be a legacy transport name such as stretch_break_suggestion
  // or break_suggestion while product-facing naming migrates to short/long break.
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
    isOptionalString(row.deliverySurface) &&
    isOptionalString(row.interactionKind) &&
    isOptionalString(row.breakKind) &&
    isOptionalString(row.promptOutcome) &&
    isOptionalString(row.overlayState) &&
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
      const payload = normalizeMachineSummaryReport(req.body);
      if (!payload) {
        res.status(400).json({ error: 'invalid machine summary payload' });
        return;
      }

      const reconciledDevice = await reconcileDeviceProfileFromTelemetry({
        deviceId: payload.deviceId ?? null,
        machineName: payload.machineName,
        agentVersion: payload.agentVersion,
        reportedAtUtc: payload.reportedAtUtc,
        accountId: payload.accountId ?? null,
        orgId: payload.orgId ?? null
      });
      await upsertMachineSummary(payload);
      if (reconciledDevice
        && reconciledDevice.status === 'active'
        && reconciledDevice.currentAccountId
        && (payload.activityDetected || Boolean(payload.lastActivityUtc)))
      {
        const activeDay = await recordAccountActiveDay({
          accountId: reconciledDevice.currentAccountId,
          activityAtUtc: payload.lastActivityUtc ?? payload.reportedAtUtc,
          machineId: payload.machineId,
          orgId: reconciledDevice.orgId ?? payload.orgId ?? null,
          source: 'machine_summary',
          metadata: {
            activityDetected: payload.activityDetected,
            trustTier: payload.trustTier,
            focusEpisodeState: payload.focusEpisodeState
          }
        });
        if (activeDay) {
          await maybeActivateAccount(reconciledDevice.currentAccountId);
        }
      }
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

      const seenDeviceIds = new Set<string>();
      for (const event of payload) {
        const deviceId = typeof event.deviceId === 'string' ? event.deviceId.trim() : '';
        if (deviceId && !seenDeviceIds.has(deviceId)) {
          await reconcileDeviceProfileFromTelemetry({
            deviceId,
            machineName: event.machineId,
            reportedAtUtc: event.timestampUtc,
            accountId: event.accountId ?? null,
            orgId: event.orgId ?? null
          });
          seenDeviceIds.add(deviceId);
        }

        await appendMachineActionEvent(event);
      }

      res.status(202).json({ accepted: true, count: payload.length });
    } catch (error) {
      next(error);
    }
  });

  // Daily digest — sent by the agent at 23:30 Dubai time (19:30 UTC) when
  // the user has been active for at least 1 hour.
  router.post('/daily-digest', async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const accountId = typeof body.accountId === 'string' && body.accountId.trim().length > 0
        ? body.accountId.trim()
        : null;

      if (!accountId) {
        res.status(400).json({ error: 'accountId is required' });
        return;
      }

      // Resolve the account's primary email
      const profile = await getAccountProfile(accountId);
      if (!profile || !profile.primaryEmail) {
        // Accept the payload silently — no email to send to yet
        res.status(202).json({ accepted: true, sent: false, reason: 'no_email' });
        return;
      }

      const payload: DailyDigestPayload = {
        accountId,
        deviceId: typeof body.deviceId === 'string' ? body.deviceId : '',
        machineId: typeof body.machineId === 'string' ? body.machineId : '',
        dateLocal: typeof body.dateLocal === 'string' ? body.dateLocal : '',
        timezoneOffsetMinutes: typeof body.timezoneOffsetMinutes === 'number' ? body.timezoneOffsetMinutes : 0,
        reportedAtUtc: typeof body.reportedAtUtc === 'string' ? body.reportedAtUtc : '',
        trackedSeconds: typeof body.trackedSeconds === 'number' ? body.trackedSeconds : 0,
        focusSeconds: typeof body.focusSeconds === 'number' ? body.focusSeconds : 0,
        focusQualityScore: typeof body.focusQualityScore === 'number' ? body.focusQualityScore : 0,
        distractionSeconds: typeof body.distractionSeconds === 'number' ? body.distractionSeconds : 0,
        awaySeconds: typeof body.awaySeconds === 'number' ? body.awaySeconds : 0,
        contextExcursionSeconds: typeof body.contextExcursionSeconds === 'number' ? body.contextExcursionSeconds : 0,
        longestFocusStreakSeconds: typeof body.longestFocusStreakSeconds === 'number' ? body.longestFocusStreakSeconds : 0,
        fragmentationEpisodeCount: typeof body.fragmentationEpisodeCount === 'number' ? body.fragmentationEpisodeCount : 0,
        socialMediaLoopCount: typeof body.socialMediaLoopCount === 'number' ? body.socialMediaLoopCount : 0,
        gamingEpisodeCount: typeof body.gamingEpisodeCount === 'number' ? body.gamingEpisodeCount : 0,
        socialMediaSeconds: typeof body.socialMediaSeconds === 'number' ? body.socialMediaSeconds : 0,
        gamingLauncherSeconds: typeof body.gamingLauncherSeconds === 'number' ? body.gamingLauncherSeconds : 0,
        gamingActiveSeconds: typeof body.gamingActiveSeconds === 'number' ? body.gamingActiveSeconds : 0,
        passiveConsumptionSeconds: typeof body.passiveConsumptionSeconds === 'number' ? body.passiveConsumptionSeconds : 0,
        commMonitoringReturnCount: typeof body.commMonitoringReturnCount === 'number' ? body.commMonitoringReturnCount : 0,
        socialMediaReturnCount: typeof body.socialMediaReturnCount === 'number' ? body.socialMediaReturnCount : 0,
        overloadEpisodeCount: typeof body.overloadEpisodeCount === 'number' ? body.overloadEpisodeCount : 0,
        breaksTakenCount: typeof body.breaksTakenCount === 'number' ? body.breaksTakenCount : 0,
        breaksSuggestedCount: typeof body.breaksSuggestedCount === 'number' ? body.breaksSuggestedCount : 0,
        mostDistractedHourLabel: typeof body.mostDistractedHourLabel === 'string' ? body.mostDistractedHourLabel : 'n/a',
        developmentSeconds: typeof body.developmentSeconds === 'number' ? body.developmentSeconds : 0,
        productivitySeconds: typeof body.productivitySeconds === 'number' ? body.productivitySeconds : 0,
        communicationSeconds: typeof body.communicationSeconds === 'number' ? body.communicationSeconds : 0,
        entertainmentSeconds: typeof body.entertainmentSeconds === 'number' ? body.entertainmentSeconds : 0
      };

      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const { subject, html } = buildDigestEmail(payload, `${baseUrl}/launch`);
      const sent = await sendEmail({ to: profile.primaryEmail, subject, html });

      if (sent) {
        console.log(`[daily-digest] Sent digest for account ${accountId} to ${profile.primaryEmail} (date: ${payload.dateLocal})`);
      } else {
        console.warn(`[daily-digest] Failed to send digest for account ${accountId} (date: ${payload.dateLocal})`);
      }

      res.status(202).json({ accepted: true, sent });
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
