import { Router } from 'express';
import { isSLOBreached } from '../../core/sloEvaluator.js';

export function createSloController(): Router {
  const router = Router();

  router.post('/evaluate', (req, res) => {
    const breached = isSLOBreached(req.body);
    res.json({ breached });
  });

  return router;
}
