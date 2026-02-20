import { appendOperatorAuditEvent } from './operatorAudit.js';
import { setCooldown, transitionRolloutState } from './rolloutStateMachine.js';
import { persistRuntimeState, runtimeState } from '../store/runtimeState.js';

export interface AutoRollbackResult {
  actionTaken: boolean;
  fromState: string;
  toState: string;
  rollbackApplied: boolean;
  reason: string;
}

function revertToPreviousConfigIfAvailable(actorId: string, reason: string): boolean {
  if (
    runtimeState.previousConfigSeq === undefined ||
    runtimeState.previousConfigVersion === undefined ||
    runtimeState.previousConfigSeq >= runtimeState.currentConfigSeq
  ) {
    return false;
  }

  const currentSeq = runtimeState.currentConfigSeq;
  const currentVersion = runtimeState.currentConfigVersion;
  runtimeState.currentConfigSeq = runtimeState.previousConfigSeq;
  runtimeState.currentConfigVersion = runtimeState.previousConfigVersion;
  runtimeState.appliedAtUtc = new Date().toISOString();
  persistRuntimeState();

  appendOperatorAuditEvent(actorId, 'rollout.config_reverted', 'runtime_state', {
    reason,
    fromConfigSeq: currentSeq,
    toConfigSeq: runtimeState.currentConfigSeq,
    fromConfigVersion: currentVersion,
    toConfigVersion: runtimeState.currentConfigVersion
  });

  return true;
}

export function executeAutoHaltRollback(actorId: string, reason: string): AutoRollbackResult {
  const fromState = runtimeState.rolloutState;

  if (fromState === 'COOLDOWN' || fromState === 'ROLLED_BACK') {
    return {
      actionTaken: false,
      fromState,
      toState: fromState,
      rollbackApplied: false,
      reason
    };
  }

  if (fromState === 'PROMOTING' || fromState === 'MONITORING') {
    transitionRolloutState('HALTED', actorId, `auto_halt:${reason}`);
  } else if (fromState === 'IDLE') {
    transitionRolloutState('HALTED', actorId, `auto_halt_idle:${reason}`);
  }

  transitionRolloutState('ROLLED_BACK', actorId, `auto_rollback:${reason}`);
  const rollbackApplied = revertToPreviousConfigIfAvailable(actorId, reason);
  setCooldown(30, actorId, `auto_rollback_cooldown:${reason}`);

  appendOperatorAuditEvent(actorId, 'rollout.auto_rollback_executed', 'rollout_state_machine', {
    reason,
    rollbackApplied,
    stateAfter: runtimeState.rolloutState,
    cooldownUntilUtc: runtimeState.cooldownUntilUtc ?? null
  });

  return {
    actionTaken: true,
    fromState,
    toState: runtimeState.rolloutState,
    rollbackApplied,
    reason
  };
}
