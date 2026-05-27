import { Router } from 'express';
import { evaluateSLOGates } from '../../core/sloEvaluator.js';
import { executeAutoHaltRollback } from '../../core/rolloutAutomation.js';
import { clearCooldownIfElapsed } from '../../core/rolloutStateMachine.js';
import { runtimeState } from '../../store/runtimeState.js';
import { OperatorRequest } from '../middleware/auth.js';

export function createSloController(): Router {
  const router = Router();

  router.post('/evaluate', (req: OperatorRequest, res) => {
    const actorId = req.operatorId ?? 'system';
    const decision = evaluateSLOGates(req.body, actorId);
    clearCooldownIfElapsed();

    let autoAction;
    if (decision.triggerAction && (runtimeState.rolloutState === 'PROMOTING' || runtimeState.rolloutState === 'MONITORING')) {
      autoAction = executeAutoHaltRollback(actorId, 'slo_breach');
    }

    res.json({
      breached: decision.breached,
      tripped: decision.tripped,
      triggerAction: decision.triggerAction,
      recovered: decision.recovered,
      aggregated: decision.aggregated,
      rolloutState: runtimeState.rolloutState,
      autoAction
    });
  });

  return router;
}
