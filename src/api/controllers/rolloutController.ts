import { Router } from 'express';
import { runtimeState } from '../../store/runtimeState.js';
import { clearCooldownIfElapsed, setCooldown, transitionRolloutState } from '../../core/rolloutStateMachine.js';

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

  router.post('/promote', (_req, res) => {
    transitionRolloutState('PROMOTING');
    res.status(202).json({ state: runtimeState.rolloutState });
  });

  router.post('/halt', (_req, res) => {
    transitionRolloutState('HALTED');
    res.status(202).json({ state: runtimeState.rolloutState });
  });

  router.post('/rollback', (_req, res) => {
    transitionRolloutState('ROLLED_BACK');
    setCooldown(30);
    res.status(202).json({ state: runtimeState.rolloutState, cooldownUntilUtc: runtimeState.cooldownUntilUtc });
  });

  return router;
}
