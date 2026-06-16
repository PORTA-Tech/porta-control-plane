import { Router } from 'express';
import {
  getJoinedMachineSummary,
  listJoinedMachineActionEventsForMachine,
  listJoinedMachineSummaries
} from '../../core/fleetReadService.js';
import { listUptimeSamples } from '../../store/machineUptimeStore.js';
import { getDailyStatsForAccount } from '../../store/dailyStatsStore.js';

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

  router.get('/:machineId/uptime', async (req, res, next) => {
    try {
      const machineId = req.params.machineId?.trim();
      if (!machineId) {
        res.status(400).json({ error: 'machineId is required' });
        return;
      }

      const parsedDays = Number.parseInt(String(req.query.days ?? '7'), 10);
      const days = Number.isFinite(parsedDays) && parsedDays > 0 ? Math.min(parsedDays, 30) : 7;
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const samples = await listUptimeSamples(machineId, since);
      res.json(samples);
    } catch (error) {
      next(error);
    }
  });

  // Per-user focus / distraction / away / overload daily history for the machine's linked
  // account. daily_stats are keyed by account (the agent posts them per account), so this
  // resolves machine -> account -> daily rows. This is the data the operations console needs
  // to show focus/distraction over Day / Week / 2-Week — previously stored but never exposed.
  router.get('/:machineId/daily-stats', async (req, res, next) => {
    try {
      const machineId = req.params.machineId?.trim();
      if (!machineId) {
        res.status(400).json({ error: 'machineId is required' });
        return;
      }

      const summary = await getJoinedMachineSummary(machineId);
      if (!summary) {
        res.status(404).json({ error: 'machine not found' });
        return;
      }

      const parsedDays = Number.parseInt(String(req.query.days ?? '14'), 10);
      const days = Number.isFinite(parsedDays) && parsedDays > 0 ? Math.min(parsedDays, 90) : 14;

      const accountId = summary.accountId;
      if (!accountId) {
        // Machine not linked to an account yet -> no per-user history to show.
        res.json([]);
        return;
      }

      const stats = await getDailyStatsForAccount(accountId, days);
      res.json(stats);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
