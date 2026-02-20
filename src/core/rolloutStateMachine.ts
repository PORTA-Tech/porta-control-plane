import { RolloutState } from '@porta/api-contracts';
import { runtimeState } from '../store/runtimeState.js';

const allowedTransitions: Record<RolloutState, RolloutState[]> = {
  IDLE: ['PROMOTING', 'HALTED'],
  PROMOTING: ['MONITORING', 'HALTED'],
  MONITORING: ['PROMOTING', 'ROLLED_BACK', 'HALTED', 'IDLE'],
  HALTED: ['ROLLED_BACK', 'COOLDOWN'],
  ROLLED_BACK: ['COOLDOWN'],
  COOLDOWN: ['IDLE']
};

export function transitionRolloutState(next: RolloutState): void {
  const current = runtimeState.rolloutState;
  if (!allowedTransitions[current].includes(next)) {
    throw new Error(`Invalid rollout transition: ${current} -> ${next}`);
  }
  runtimeState.rolloutState = next;
}

export function setCooldown(minutes: number): void {
  const until = new Date(Date.now() + minutes * 60_000).toISOString();
  runtimeState.cooldownUntilUtc = until;
  runtimeState.rolloutState = 'COOLDOWN';
}

export function clearCooldownIfElapsed(): void {
  if (!runtimeState.cooldownUntilUtc) return;
  if (Date.now() >= Date.parse(runtimeState.cooldownUntilUtc)) {
    runtimeState.cooldownUntilUtc = undefined;
    runtimeState.rolloutState = 'IDLE';
  }
}
