import { Router } from 'express';
import { runtimeState } from '../../store/runtimeState.js';
import { OperatorRequest } from '../middleware/auth.js';
import { RolloutTransitionError, clearCooldownIfElapsed, transitionRolloutState } from '../../core/rolloutStateMachine.js';
import { executeAutoHaltRollback } from '../../core/rolloutAutomation.js';

export function createRolloutController(): Router {
  const router = Router();

  router.get('/state', (_req, res) => {
    clearCooldownIfElapsed();
    res.json({
      state: runtimeState.rolloutState,
      activeConfigSeq: runtimeState.currentConfigSeq,
      cooldownUntilUtc: runtimeState.cooldownUntilUtc,
      updatedAtUtc: new Date().toISOString()
    });
  });

  router.post('/promote', (req: OperatorRequest, res) => {
    const actorId = req.operatorId ?? 'unknown';
    clearCooldownIfElapsed();
    try {
      const transition = transitionRolloutState('PROMOTING', actorId, 'operator_promote');
      res.status(transition.idempotent ? 200 : 202).json({
        state: runtimeState.rolloutState,
        transition
      });
    } catch (error) {
      if (error instanceof RolloutTransitionError) {
        res.status(409).json({ error: error.code, from: error.from, to: error.to });
        return;
      }

      throw error;
    }
  });

  router.post('/halt', (req: OperatorRequest, res) => {
    const actorId = req.operatorId ?? 'unknown';
    clearCooldownIfElapsed();
    try {
      const transition = transitionRolloutState('HALTED', actorId, 'operator_halt');
      res.status(transition.idempotent ? 200 : 202).json({
        state: runtimeState.rolloutState,
        transition
      });
    } catch (error) {
      if (error instanceof RolloutTransitionError) {
        res.status(409).json({ error: error.code, from: error.from, to: error.to });
        return;
      }

      throw error;
    }
  });

  router.post('/rollback', (req: OperatorRequest, res) => {
    const actorId = req.operatorId ?? 'unknown';
    clearCooldownIfElapsed();
    try {
      const result = executeAutoHaltRollback(actorId, 'operator_forced');
      res.status(result.actionTaken ? 202 : 200).json({
        state: runtimeState.rolloutState,
        actionTaken: result.actionTaken,
        rollbackApplied: result.rollbackApplied,
        reason: result.reason,
        fromState: result.fromState,
        toState: result.toState,
        cooldownUntilUtc: runtimeState.cooldownUntilUtc
      });
    } catch (error) {
      if (error instanceof RolloutTransitionError) {
        res.status(409).json({ error: error.code, from: error.from, to: error.to });
        return;
      }

      throw error;
    }
  });

  return router;
}
