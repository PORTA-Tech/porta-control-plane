import { Router } from 'express';
import { evaluateSystemHealth, recordSystemUiHealthSample } from '../../core/systemHealthEngine.js';
import { getFleetDatabaseUrl, getFleetPersistenceMode } from '../../store/fleetPersistence.js';

export function createSystemHealthController(): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      ...evaluateSystemHealth(),
      fleet_reporting: {
        persistence_mode: getFleetPersistenceMode(),
        database_configured: getFleetDatabaseUrl() !== null
      }
    });
  });

  router.post('/ui-metrics', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    recordSystemUiHealthSample(body);
    res.status(202).json({ ok: true });
  });

  return router;
}
