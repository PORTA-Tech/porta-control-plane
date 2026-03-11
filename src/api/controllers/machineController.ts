import { Router } from 'express';
import {
  getJoinedMachineSummary,
  listJoinedMachineActionEventsForMachine,
  listJoinedMachineSummaries
} from '../../core/fleetReadService.js';

export function createMachineController(): Router {
  const router = Router();

  router.get('/summary', async (_req, res, next) => {
    try {
      const rows = await listJoinedMachineSummaries();
      res.json(rows);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:machineId', async (req, res, next) => {
    try {
      const machineId = req.params.machineId?.trim();
      if (!machineId) {
        res.status(400).json({ error: 'machineId is required' });
        return;
      }

      const row = await getJoinedMachineSummary(machineId);
      if (!row) {
        res.status(404).json({ error: 'machine not found' });
        return;
      }

      res.json(row);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:machineId/actions', async (req, res, next) => {
    try {
      const machineId = req.params.machineId?.trim();
      if (!machineId) {
        res.status(400).json({ error: 'machineId is required' });
        return;
      }

      const parsedLimit = Number.parseInt(String(req.query.limit ?? '100'), 10);
      const limit = Number.isFinite(parsedLimit) ? parsedLimit : 100;
      const rows = await listJoinedMachineActionEventsForMachine(machineId, limit);
      res.json(rows);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
