import { beforeEach, describe, expect, it } from 'vitest';
import type { MachineActionEvent, MachineSummaryReport } from '@porta/api-contracts';
import { clearMachineActionStoreForTests, appendMachineActionEvent, listMachineActionEventsForMachine, listRecentMachineActionEvents } from '../src/store/machineActionStore.js';
import { clearMachineSummaryStoreForTests, getMachineSummary, listMachineSummaries, upsertMachineSummary, withCanonicalMachineSummary } from '../src/store/machineSummaryStore.js';
import {
  assertFleetPersistenceConfigured,
  getFleetPersistenceMode,
  resetFleetPersistenceForTests
} from '../src/store/fleetPersistence.js';

const summaryA: MachineSummaryReport = {
  machineId: 'machine-a',
  machineName: 'Machine A',
  userName: 'hp',
  agentVersion: '1.0.0',
  schemaVersion: '1.0.0',
  policyVersion: 'policy-a',
  reportedAtUtc: '2026-03-10T10:00:00.000Z',
  agentRunning: true,
  userSessionConnected: true,
  activityDetected: true,
  lastActivityUtc: '2026-03-10T09:59:59.000Z',
  userAgentHeartbeatUtc: '2026-03-10T10:00:00.000Z',
  captureContext: 'UserSession',
  keyboardSignalActive: true,
  mouseSignalActive: false,
  ownershipWarning: null,
  captureFailureReason: null,
  lastError: null,
  backendConnected: true,
  localApiAuthReady: true,
  dbMigrationFailed: false,
  focusEpisodeQuality: 0.85,
  focusEpisodeSeconds: 1800,
  focusEpisodeState: 'keep',
  focusEpisodeReasonCode: 'focus_episode_active',
  focusEpisodeReasonText: 'Focus episode active.',
  attentionSegmentKind: 'focus',
  attentionSegmentSeconds: 0,
  attentionSegmentReasonCode: 'steady_focus',
  attentionSegmentReasonText: 'Steady focus episode.',
  distractionEpisodeActive: false,
  distractionEpisodeSeconds: 0,
  taskContinuityScore: 0.85,
  taskContinuitySeconds: 1800,
  continuityState: 'keep',
  deepWorkActive: true,
  pressureLevel: 0.47,
  pressureConfidence: 0.86,
  overloadLikelihood: 0.33,
  overloadActive: false,
  breakNeeded: false,
  breakPendingAction: null,
  breakPendingReasonCode: null,
  calibrationStage: 'calibrated',
  trustTier: 'high',
  modelConfidence: 0.86,
  signalQualityScore: 0.91,
  partialData: false,
  missingMajorChannels: []
};

const summaryB: MachineSummaryReport = {
  ...summaryA,
  machineId: 'machine-b',
  machineName: 'Machine B',
  reportedAtUtc: '2026-03-10T10:05:00.000Z',
  trustTier: 'medium',
  calibrationStage: 'provisional'
};

const actionA: MachineActionEvent = {
  machineId: 'machine-a',
  userName: 'hp',
  interventionId: 'int-1',
  action: 'break_suggestion',
  actionCategory: 'suggestion',
  decisionState: 'decided',
  executionState: 'applied',
  verifiedState: 'unverified',
  timestampUtc: '2026-03-10T10:01:00.000Z',
  appliedAtUtc: '2026-03-10T10:01:02.000Z',
  errorCode: null,
  deliverySurface: 'break_overlay',
  interactionKind: 'choice_prompt',
  breakKind: 'long_break',
  promptOutcome: 'accepted',
  overlayState: 'countdown_active',
  policyId: 'break-policy-v2',
  whatChanged: 'Long break suggestion displayed to user.',
  howToUndo: null
};

const actionB: MachineActionEvent = {
  ...actionA,
  interventionId: 'int-2',
  machineId: 'machine-b',
  action: 'deep_work_notifications_suppressed',
  actionCategory: 'automatic_change',
  executionState: 'verified',
  verifiedState: 'verified',
  timestampUtc: '2026-03-10T10:06:00.000Z',
  appliedAtUtc: '2026-03-10T10:06:01.000Z'
};

describe('fleet stores', () => {
  beforeEach(async () => {
    delete process.env.PORTA_CONTROL_PLANE_DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.PORTA_CONTROL_PLANE_REQUIRE_PERSISTENT_FLEET;
    delete process.env.PORTA_CONTROL_PLANE_ALLOW_IN_MEMORY_FLEET;
    delete process.env.RENDER;
    process.env.NODE_ENV = 'test';
    expect(getFleetPersistenceMode()).toBe('memory');
    clearMachineSummaryStoreForTests();
    clearMachineActionStoreForTests();
    await resetFleetPersistenceForTests();
  });

  it('upserts and lists machine summaries in reported time order', async () => {
    await upsertMachineSummary(summaryA);
    await upsertMachineSummary(summaryB);

    const rows = await listMachineSummaries();
    expect(rows.map((row) => row.machineId)).toEqual(['machine-b', 'machine-a']);

    const loaded = await getMachineSummary('machine-a');
    expect(loaded?.trustTier).toBe('high');
    expect(loaded?.focusEpisodeSeconds).toBe(1800);
    expect(loaded?.taskContinuitySeconds).toBe(1800);
    expect(loaded?.pressureLevel).toBe(0.47);
    expect(loaded?.overloadLikelihood).toBe(0.47);
    expect(loaded?.attentionSegmentKind).toBe('focus');
    expect(loaded?.distractionEpisodeActive).toBe(false);
    expect(loaded?.focusEpisodeReasonText).toBe('Focus episode active.');
    expect(loaded?.attentionSegmentReasonText).toBe('Steady focus episode.');
  });

  it('normalizes canonical focus, pressure, and break fields from compatibility values', () => {
    const report: MachineSummaryReport = {
      ...summaryA,
      focusEpisodeQuality: Number.NaN,
      focusEpisodeSeconds: Number.NaN,
      focusEpisodeState: '',
      pressureLevel: Number.NaN,
      pressureConfidence: Number.NaN,
      breakPendingKind: null,
      breakPendingAction: 'break_suggestion',
      taskContinuityScore: 0.66,
      taskContinuitySeconds: 1800,
      continuityState: 'keep',
      overloadLikelihood: 0.77
    };

    const normalized = withCanonicalMachineSummary(report);

    expect(normalized.focusEpisodeSeconds).toBe(1800);
    expect(normalized.focusEpisodeQuality).toBe(0.66);
    expect(normalized.pressureLevel).toBe(0.77);
    expect(normalized.breakPendingKind).toBe('long_break');
    expect(normalized.breakPendingAction).toBe('break_suggestion');
  });

  it('treats canonical summary fields as admin truth and mirrors legacy aliases from them', async () => {
    await upsertMachineSummary({
      ...summaryA,
      focusEpisodeQuality: 0.91,
      focusEpisodeSeconds: 2700,
      focusEpisodeState: 'pause',
      taskContinuityScore: 0.12,
      taskContinuitySeconds: 45,
      continuityState: 'reset',
      pressureLevel: 0.73,
      overloadLikelihood: 0.19,
      breakNeeded: false,
      breakPendingKind: 'long_break',
      breakPendingAction: 'stretch_break_suggestion'
    });

    const loaded = await getMachineSummary('machine-a');
    expect(loaded?.focusEpisodeQuality).toBe(0.91);
    expect(loaded?.focusEpisodeSeconds).toBe(2700);
    expect(loaded?.focusEpisodeState).toBe('pause');
    expect(loaded?.taskContinuityScore).toBe(0.91);
    expect(loaded?.taskContinuitySeconds).toBe(2700);
    expect(loaded?.continuityState).toBe('pause');
    expect(loaded?.pressureLevel).toBe(0.73);
    expect(loaded?.overloadLikelihood).toBe(0.73);
    expect(loaded?.breakNeeded).toBe(true);
    expect(loaded?.breakPendingKind).toBe('long_break');
    expect(loaded?.breakPendingAction).toBe('break_suggestion');
  });

  it('keeps high pressure separate from overload activation in admin truth', async () => {
    await upsertMachineSummary({
      ...summaryA,
      pressureLevel: 0.82,
      pressureConfidence: 0.43,
      overloadLikelihood: 0.26,
      overloadActive: false
    });

    const loaded = await getMachineSummary('machine-a');
    expect(loaded?.pressureLevel).toBe(0.82);
    expect(loaded?.pressureConfidence).toBe(0.43);
    expect(loaded?.overloadActive).toBe(false);
    expect(loaded?.overloadLikelihood).toBe(0.82);
  });

  it('derives duration-rich reset reasons from canonical episode fields when explicit text is missing', () => {
    const normalized = withCanonicalMachineSummary({
      ...summaryA,
      focusEpisodeState: 'reset',
      focusEpisodeReasonCode: null,
      focusEpisodeReasonText: null,
      attentionSegmentKind: 'fragmentation_distraction',
      attentionSegmentSeconds: 90,
      attentionSegmentReasonCode: null,
      attentionSegmentReasonText: null,
      distractionEpisodeActive: true,
      distractionEpisodeSeconds: 125
    });

    expect(normalized.attentionSegmentReasonText).toBe('Rapid switching / fragmentation for 2m 5s.');
    expect(normalized.focusEpisodeReasonCode).toBe('instability_reset');
    expect(normalized.focusEpisodeReasonText).toBe('Sustained instability ended the focus episode after 2m 5s.');
  });

  it('accepts canonical-only payload without legacy fields and uplifts correctly', async () => {
    const canonicalOnly: MachineSummaryReport = {
      ...summaryA,
      focusEpisodeQuality: 0.78,
      focusEpisodeSeconds: 2400,
      focusEpisodeState: 'keep',
      pressureLevel: 0.44,
      pressureConfidence: 0.81,
      // Legacy fields intentionally absent — canonical ingestion must work without them
      taskContinuityScore: 0.78,
      taskContinuitySeconds: 2400,
      continuityState: 'keep',
      overloadLikelihood: 0.44,
      breakPendingKind: 'short_break',
      breakPendingAction: null
    };

    await upsertMachineSummary(canonicalOnly);
    const loaded = await getMachineSummary('machine-a');

    expect(loaded?.focusEpisodeSeconds).toBe(2400);
    expect(loaded?.taskContinuitySeconds).toBe(2400);   // alias mirrors canonical
    expect(loaded?.pressureLevel).toBe(0.44);
    expect(loaded?.overloadLikelihood).toBe(0.44);      // alias mirrors canonical
    expect(loaded?.breakPendingKind).toBe('short_break');
    expect(loaded?.breakNeeded).toBe(true);
  });

  it('uplifts legacy-only break transport to canonical break kind', () => {
    // Old agents still send breakPendingAction with legacy names.
    const legacyBreak = withCanonicalMachineSummary({
      ...summaryA,
      breakPendingKind: null,
      breakPendingAction: 'stretch_break_suggestion',
      breakNeeded: false
    });

    expect(legacyBreak.breakPendingKind).toBe('short_break');
    expect(legacyBreak.breakNeeded).toBe(true);
    // Legacy transport field preserved for backward-compat readers
    expect(legacyBreak.breakPendingAction).toBe('stretch_break_suggestion');
  });

  it('appends and filters machine action events in reverse time order', async () => {
    await appendMachineActionEvent(actionA);
    await appendMachineActionEvent(actionB);

    const recent = await listRecentMachineActionEvents();
    expect(recent.map((row) => row.interventionId)).toEqual(['int-2', 'int-1']);

    const machineRows = await listMachineActionEventsForMachine('machine-a');
    expect(machineRows).toHaveLength(1);
    expect(machineRows[0]?.actionCategory).toBe('suggestion');
  });

  it('deduplicates repeated action writes for the same lifecycle row in memory mode', async () => {
    await appendMachineActionEvent(actionA);
    await appendMachineActionEvent({ ...actionA, whatChanged: 'Updated wording' });

    const machineRows = await listMachineActionEventsForMachine('machine-a');
    expect(machineRows).toHaveLength(1);
    expect(machineRows[0]?.whatChanged).toBe('Updated wording');
  });

  it('fails fast when production-like env would start with in-memory fleet state', () => {
    process.env.NODE_ENV = 'production';
    expect(() => assertFleetPersistenceConfigured()).toThrow(/PORTA_CONTROL_PLANE_DATABASE_URL|DATABASE_URL/);
  });

  it('allows in-memory fleet state when explicitly overridden', () => {
    process.env.NODE_ENV = 'production';
    process.env.PORTA_CONTROL_PLANE_ALLOW_IN_MEMORY_FLEET = 'true';
    expect(() => assertFleetPersistenceConfigured()).not.toThrow();
  });
});
