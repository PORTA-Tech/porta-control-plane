import { Router, Response } from 'express';
import { ConfigEnvelope } from '@porta/api-contracts';
import { applySignedConfig } from '../../core/configManager.js';
import { readLedger } from '../../core/auditLedger.js';
import { runtimeState } from '../../store/runtimeState.js';
import { OperatorRequest } from '../middleware/auth.js';

function statusForReason(reason?: string): number {
  if (!reason) return 202;
  if (reason === 'config_seq_not_monotonic') return 409;
  if (reason === 'issuer_untrusted' || reason === 'signature_invalid' || reason === 'algorithm_unsupported') return 403;
  return 400;
}

export function createConfigController(): Router {
  const router = Router();

  router.post('/submit', (req: OperatorRequest, res: Response) => {
    const envelope = req.body as ConfigEnvelope;
    const actorId = req.operatorId ?? 'unknown';
    const result = applySignedConfig(envelope, actorId);
    res.status(statusForReason(result.reason)).json(result);
  });

  router.get('/current', (_req, res) => {
    res.json({
      configSeq: runtimeState.currentConfigSeq,
      configVersion: runtimeState.currentConfigVersion,
      appliedAtUtc: runtimeState.appliedAtUtc
    });
  });

  router.get('/ledger', (_req, res) => {
    res.json(readLedger());
  });

  return router;
}
