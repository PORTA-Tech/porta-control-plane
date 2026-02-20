import { Router } from 'express';
import { readLedger } from '../../core/auditLedger.js';
import { readOperatorAuditEvents } from '../../core/operatorAudit.js';
import { dispatchOutbox, getOutboxStatus } from '../../core/outbox.js';

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

  router.get('/outbox/status', (_req, res) => {
    res.json(getOutboxStatus());
  });

  router.post('/outbox/dispatch', (req, res) => {
    const maxRaw = Number(req.query.max ?? 100);
    const max = Number.isFinite(maxRaw) ? Math.max(1, Math.min(5000, Math.trunc(maxRaw))) : 100;
    res.json(dispatchOutbox(max));
  });

  return router;
}
