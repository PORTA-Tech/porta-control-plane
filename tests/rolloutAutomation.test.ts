import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { executeAutoHaltRollback } from '../src/core/rolloutAutomation.js';
import { loadRuntimeState, resetRuntimeStateForTests, runtimeState } from '../src/store/runtimeState.js';

const dataDir = path.resolve('.data');

describe('rollout automation', () => {
  beforeEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    resetRuntimeStateForTests();
    loadRuntimeState();
  });

  it('halts, rolls back config, and enters cooldown from promoting state', () => {
    runtimeState.rolloutState = 'PROMOTING';
    runtimeState.previousConfigSeq = 6;
    runtimeState.previousConfigVersion = '2026.02.20.06';
    runtimeState.currentConfigSeq = 7;
    runtimeState.currentConfigVersion = '2026.02.20.07';

    const result = executeAutoHaltRollback('system', 'slo_breach');

    expect(result.actionTaken).toBe(true);
    expect(result.fromState).toBe('PROMOTING');
    expect(result.toState).toBe('COOLDOWN');
    expect(result.rollbackApplied).toBe(true);
    expect(runtimeState.currentConfigSeq).toBe(6);
    expect(runtimeState.currentConfigVersion).toBe('2026.02.20.06');
    expect(runtimeState.rolloutState).toBe('COOLDOWN');
    expect(runtimeState.cooldownUntilUtc).toBeDefined();
  });

  it('is idempotent in cooldown state', () => {
    runtimeState.rolloutState = 'COOLDOWN';
    runtimeState.cooldownUntilUtc = new Date(Date.now() + 30_000).toISOString();

    const result = executeAutoHaltRollback('system', 'slo_breach');

    expect(result.actionTaken).toBe(false);
    expect(result.fromState).toBe('COOLDOWN');
    expect(result.toState).toBe('COOLDOWN');
    expect(result.rollbackApplied).toBe(false);
  });
});
