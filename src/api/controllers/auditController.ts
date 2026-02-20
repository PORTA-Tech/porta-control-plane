import { Router } from 'express';
import { readLedger } from '../../core/auditLedger.js';
import { readOperatorAuditEvents } from '../../core/operatorAudit.js';

export function createAuditController(): Router {
  const router = Router();

  router.get('/events', (_req, res) => {
    res.json(readLedger());
  });

  router.get('/rollout-events', (req, res) => {
    const limitRaw = Number(req.query.limit ?? 200);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.trunc(limitRaw))) : 200;
    res.json(readOperatorAuditEvents(limit));
  });

  return router;
}
