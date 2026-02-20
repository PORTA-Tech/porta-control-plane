import { Router } from 'express';
import { readLedger } from '../../core/auditLedger.js';

export function createAuditController(): Router {
  const router = Router();
  router.get('/events', (_req, res) => {
    res.json(readLedger());
  });
  return router;
}
