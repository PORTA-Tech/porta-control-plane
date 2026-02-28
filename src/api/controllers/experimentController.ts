import { Router } from 'express';
import type { OperatorRequest } from '../middleware/auth.js';
import {
  evaluateExperiment,
  listExperimentEvents,
  stopExperiment,
  type ExperimentDefinitionInput
} from '../../core/experimentEvaluationEngine.js';

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

export function createExperimentController(): Router {
  const router = Router();

  router.post('/evaluate', (req, res) => {
    const operatorReq = req as OperatorRequest;
    const actorId = operatorReq.operatorId ?? 'operator-unknown';
    const definition = (req.body ?? {}) as ExperimentDefinitionInput;

    const result = evaluateExperiment({
      actorId,
      definition
    });

    res.json(result);
  });

  router.get('/events', (req, res) => {
    const experimentId = readQueryString(req.query.experiment_id);
    const limitRaw = Number(readQueryString(req.query.limit));
    const events = listExperimentEvents({
      ...(experimentId ? { experimentId } : {}),
      ...(Number.isFinite(limitRaw) ? { limit: limitRaw } : {})
    });
    res.json(events);
  });

  router.post('/:experimentId/stop', (req, res) => {
    const operatorReq = req as OperatorRequest;
    const actorId = operatorReq.operatorId ?? 'operator-unknown';
    const experimentId = req.params.experimentId;
    const reason =
      req.body && typeof req.body === 'object' && typeof (req.body as { reason?: unknown }).reason === 'string'
        ? (req.body as { reason: string }).reason
        : undefined;

    const result = stopExperiment({
      actorId,
      experimentId,
      ...(reason ? { reason } : {})
    });

    if (!result.stopped) {
      res.status(404).json({ error: 'experiment_not_found' });
      return;
    }

    res.json(result);
  });

  return router;
}
