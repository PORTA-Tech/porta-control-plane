import { Router } from 'express';
import { getMachineSummary, listMachineSummaries } from '../../store/machineSummaryStore.js';
import { listMachineActionEventsForMachine } from '../../store/machineActionStore.js';

export function createMachineController(): Router {
  const router = Router();

  router.get('/summary', async (_req, res, next) => {
    try {
      const rows = await listMachineSummaries();
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

      const row = await getMachineSummary(machineId);
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
      const rows = await listMachineActionEventsForMachine(machineId, limit);
      res.json(rows);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
