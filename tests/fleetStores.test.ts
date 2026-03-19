import { beforeEach, describe, expect, it } from 'vitest';
import type { MachineActionEvent, MachineSummaryReport } from '@porta/api-contracts';
import { clearMachineActionStoreForTests, appendMachineActionEvent, listMachineActionEventsForMachine, listRecentMachineActionEvents } from '../src/store/machineActionStore.js';
import { clearMachineSummaryStoreForTests, getMachineSummary, listMachineSummaries, upsertMachineSummary } from '../src/store/machineSummaryStore.js';
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
  taskContinuityScore: 0.85,
  taskContinuitySeconds: 1800,
  continuityState: 'keep',
  deepWorkActive: true,
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
  policyId: 'break-policy-v2',
  whatChanged: 'Displayed a break suggestion to the user.',
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
    expect(loaded?.taskContinuitySeconds).toBe(1800);
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
