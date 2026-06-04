import { Router } from 'express';
import { listDigestLogEntries } from '../../store/digestLogStore.js';

export function createDigestController(): Router {
  const router = Router();

  router.get('/log', async (req, res, next) => {
    try {
      const parsedLimit = Number.parseInt(String(req.query.limit ?? '100'), 10);
      const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 100;
      const entries = await listDigestLogEntries(limit);
      res.json(entries);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
