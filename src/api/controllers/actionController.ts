import { Router } from 'express';
import { listRecentJoinedMachineActionEvents } from '../../core/fleetReadService.js';

export function createActionController(): Router {
  const router = Router();

  router.get('/recent', async (req, res, next) => {
    try {
      const parsedLimit = Number.parseInt(String(req.query.limit ?? '100'), 10);
      const limit = Number.isFinite(parsedLimit) ? parsedLimit : 100;
      const rows = await listRecentJoinedMachineActionEvents(limit);
      res.json(rows);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
