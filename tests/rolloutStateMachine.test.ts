import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readOperatorAuditEvents } from '../src/core/operatorAudit.js';
import { RolloutTransitionError, clearCooldownIfElapsed, setCooldown, transitionRolloutState } from '../src/core/rolloutStateMachine.js';
import { loadRuntimeState, resetRuntimeStateForTests, runtimeState } from '../src/store/runtimeState.js';

const dataDir = path.resolve('.data');

describe('rollout state machine', () => {
  beforeEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    resetRuntimeStateForTests();
    loadRuntimeState();
  });

  it('applies valid transition and returns changed result', () => {
    const result = transitionRolloutState('PROMOTING', 'operator-a', 'test_promote');

    expect(result.changed).toBe(true);
    expect(result.idempotent).toBe(false);
    expect(result.from).toBe('IDLE');
    expect(result.to).toBe('PROMOTING');
    expect(runtimeState.rolloutState).toBe('PROMOTING');
  });

  it('is idempotent when transitioning to current state', () => {
    transitionRolloutState('PROMOTING', 'operator-a', 'test_promote');
    const again = transitionRolloutState('PROMOTING', 'operator-a', 'test_promote');

    expect(again.changed).toBe(false);
    expect(again.idempotent).toBe(true);
    expect(runtimeState.rolloutState).toBe('PROMOTING');
  });

  it('rejects invalid transitions with explicit error', () => {
    expect(() => transitionRolloutState('ROLLED_BACK', 'operator-a', 'bad_jump')).toThrow(RolloutTransitionError);
    expect(runtimeState.rolloutState).toBe('IDLE');
  });

  it('sets cooldown and auto-recovers to idle after expiry', () => {
    transitionRolloutState('HALTED', 'operator-a', 'halt_for_rollback');
    transitionRolloutState('ROLLED_BACK', 'operator-a', 'rollback');
    setCooldown(1, 'operator-a', 'cooldown');

    expect(runtimeState.rolloutState).toBe('COOLDOWN');
    runtimeState.cooldownUntilUtc = new Date(Date.now() - 1000).toISOString();

    const recovery = clearCooldownIfElapsed();
    expect(recovery?.to).toBe('IDLE');
    expect(runtimeState.rolloutState).toBe('IDLE');
    expect(runtimeState.cooldownUntilUtc).toBeUndefined();
  });

  it('writes transition audit events', () => {
    transitionRolloutState('PROMOTING', 'operator-a', 'test_promote');
    const events = readOperatorAuditEvents(20);

    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)?.action).toBe('rollout.transition');
  });
});
