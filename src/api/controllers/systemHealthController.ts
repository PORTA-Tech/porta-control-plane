import { Router } from 'express';
import { evaluateSystemHealth, recordSystemUiHealthSample } from '../../core/systemHealthEngine.js';

export function createSystemHealthController(): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json(evaluateSystemHealth());
  });

  router.post('/ui-metrics', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    recordSystemUiHealthSample(body);
    res.status(202).json({ ok: true });
  });

  return router;
}
