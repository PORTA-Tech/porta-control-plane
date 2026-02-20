import { Router } from 'express';
import { runtimeState } from '../../store/runtimeState.js';
import { OperatorRequest } from '../middleware/auth.js';
import { RolloutTransitionError, clearCooldownIfElapsed, setCooldown, transitionRolloutState } from '../../core/rolloutStateMachine.js';

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
    try {
      const rollback = transitionRolloutState('ROLLED_BACK', actorId, 'operator_rollback');
      const cooldown = setCooldown(30, actorId, 'rollback_cooldown');
      res.status(rollback.idempotent ? 200 : 202).json({
        state: runtimeState.rolloutState,
        rollback,
        cooldown,
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
