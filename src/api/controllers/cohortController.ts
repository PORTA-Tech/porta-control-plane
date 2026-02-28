import { Router } from 'express';
import type { OperatorRequest } from '../middleware/auth.js';
import { evaluateCohorts } from '../../core/cohortEvaluationEngine.js';

function readQueryString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === 'string' && entry.trim().length > 0);
    if (typeof first === 'string') {
      return first.trim();
    }
  }
  return undefined;
}

export function createCohortController(): Router {
  const router = Router();

  router.get('/evaluate', (req, res) => {
    const operatorReq = req as OperatorRequest;
    const window = readQueryString(req.query.window);
    const baselineCohortId =
      readQueryString(req.query.baseline_cohort_id) ?? readQueryString(req.query.baselineCohortId);

    const snapshot = evaluateCohorts({
      ...(window ? { window } : {}),
      ...(baselineCohortId ? { baselineCohortId } : {}),
      ...(operatorReq.operatorId ? { actorId: operatorReq.operatorId } : {})
    });

    res.json(snapshot);
  });

  return router;
}
