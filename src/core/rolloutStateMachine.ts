import { RolloutState } from '@porta/api-contracts';
import { appendOperatorAuditEvent } from './operatorAudit.js';
import { persistRuntimeState, runtimeState } from '../store/runtimeState.js';

const allowedTransitions: Record<RolloutState, RolloutState[]> = {
  IDLE: ['PROMOTING', 'HALTED'],
  PROMOTING: ['MONITORING', 'HALTED'],
  MONITORING: ['PROMOTING', 'ROLLED_BACK', 'HALTED', 'IDLE'],
  HALTED: ['ROLLED_BACK', 'COOLDOWN'],
  ROLLED_BACK: ['COOLDOWN'],
  COOLDOWN: ['IDLE']
};

export interface RolloutTransitionResult {
  changed: boolean;
  idempotent: boolean;
  from: RolloutState;
  to: RolloutState;
  atUtc: string;
  reason: string;
}

export class RolloutTransitionError extends Error {
  public readonly code = 'invalid_transition';
  public readonly from: RolloutState;
  public readonly to: RolloutState;

  public constructor(from: RolloutState, to: RolloutState) {
    super(`Invalid rollout transition: ${from} -> ${to}`);
    this.from = from;
    this.to = to;
  }
}

function emitTransitionAudit(actorId: string, transition: RolloutTransitionResult): void {
  appendOperatorAuditEvent(actorId, 'rollout.transition', 'rollout_state_machine', {
    from: transition.from,
    to: transition.to,
    reason: transition.reason,
    idempotent: transition.idempotent
  });
}

export function transitionRolloutState(next: RolloutState, actorId: string, reason: string): RolloutTransitionResult {
  const current = runtimeState.rolloutState;
  const atUtc = new Date().toISOString();

  if (current === next) {
    const result: RolloutTransitionResult = {
      changed: false,
      idempotent: true,
      from: current,
      to: next,
      atUtc,
      reason
    };

    emitTransitionAudit(actorId, result);
    return result;
  }

  if (!allowedTransitions[current].includes(next)) {
    appendOperatorAuditEvent(actorId, 'rollout.transition_rejected', 'rollout_state_machine', {
      from: current,
      to: next,
      reason,
      code: 'invalid_transition'
    });
    throw new RolloutTransitionError(current, next);
  }

  runtimeState.rolloutState = next;
  persistRuntimeState();

  const result: RolloutTransitionResult = {
    changed: true,
    idempotent: false,
    from: current,
    to: next,
    atUtc,
    reason
  };

  emitTransitionAudit(actorId, result);
  return result;
}

export function setCooldown(minutes: number, actorId: string, reason: string): RolloutTransitionResult {
  const until = new Date(Date.now() + minutes * 60_000).toISOString();
  runtimeState.cooldownUntilUtc = until;
  const result = transitionRolloutState('COOLDOWN', actorId, reason);
  appendOperatorAuditEvent(actorId, 'rollout.cooldown_set', 'rollout_state_machine', {
    cooldownUntilUtc: until,
    minutes,
    changed: result.changed
  });
  persistRuntimeState();
  return result;
}

export function clearCooldownIfElapsed(): RolloutTransitionResult | undefined {
  if (!runtimeState.cooldownUntilUtc) {
    return;
  }

  if (Date.now() >= Date.parse(runtimeState.cooldownUntilUtc)) {
    const previous = runtimeState.cooldownUntilUtc;
    runtimeState.cooldownUntilUtc = undefined;
    const result = transitionRolloutState('IDLE', 'system', 'cooldown_elapsed');
    appendOperatorAuditEvent('system', 'rollout.cooldown_cleared', 'rollout_state_machine', {
      previousCooldownUntilUtc: previous
    });
    persistRuntimeState();
    return result;
  }
}
