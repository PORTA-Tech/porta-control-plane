import { Router } from 'express';
import type { GrowthSeriesInterval, GrowthSeriesMetric } from '@porta/api-contracts';
import {
  readGrowthCohorts,
  readGrowthSeries,
  readGrowthSummary,
  readGrowthUserJourney
} from '../../core/growthReadService.js';

function parsePositiveInteger(input: unknown): number | null {
  const value = typeof input === 'string' ? Number.parseInt(input, 10) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parseSingleQueryValue(input: unknown): string | null {
  return typeof input === 'string' && input.trim().length > 0 ? input.trim() : null;
}

function isValidDateTime(input: string): boolean {
  return Number.isFinite(Date.parse(input));
}

function isValidDate(input: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(input) && Number.isFinite(Date.parse(`${input}T00:00:00.000Z`));
}

export function createGrowthController(): Router {
  const router = Router();

  router.get('/summary', async (req, res, next) => {
    try {
      const rawWindowDays = parseSingleQueryValue(req.query.window_days);
      if (rawWindowDays && parsePositiveInteger(rawWindowDays) === null) {
        res.status(400).json({ error: 'window_days must be a positive integer' });
        return;
      }

      const windowDays = parsePositiveInteger(rawWindowDays) ?? undefined;
      const summary = await readGrowthSummary(windowDays);
      res.json({
        timezone: summary.timezone,
        generated_at_utc: summary.generatedAtUtc,
        window_start_utc: summary.windowStartUtc,
        window_end_utc: summary.windowEndUtc,
        total_registered_users: summary.totalRegisteredUsers,
        new_registered_users: summary.newRegisteredUsers,
        activated_users: summary.activatedUsers,
        activation_rate_pct: summary.activationRatePct,
        retention_rate_d1_pct: summary.retentionRateD1Pct,
        retention_rate_d7_pct: summary.retentionRateD7Pct,
        retention_rate_d30_pct: summary.retentionRateD30Pct,
        churn_rate_d1_pct: summary.churnRateD1Pct,
        churn_rate_d7_pct: summary.churnRateD7Pct,
        churn_rate_d30_pct: summary.churnRateD30Pct,
        total_installs: summary.totalInstalls,
        reporting_machines_48h: summary.reportingMachines48h,
        linked_machines: summary.linkedMachines,
        unlinked_machines: summary.unlinkedMachines,
        install_to_registration_rate_pct: summary.installToRegistrationRatePct
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/series', async (req, res, next) => {
    try {
      const metric = parseSingleQueryValue(req.query.metric);
      if (!metric || !['registrations', 'activations', 'active_users', 'installs'].includes(metric)) {
        res.status(400).json({ error: 'metric must be one of registrations, activations, active_users, installs' });
        return;
      }

      const interval = parseSingleQueryValue(req.query.interval);
      if (interval && !['day', 'week', 'month'].includes(interval)) {
        res.status(400).json({ error: 'interval must be one of day, week, month' });
        return;
      }

      const from = parseSingleQueryValue(req.query.from);
      if (from && !isValidDateTime(from)) {
        res.status(400).json({ error: 'from must be a valid date-time' });
        return;
      }

      const to = parseSingleQueryValue(req.query.to);
      if (to && !isValidDateTime(to)) {
        res.status(400).json({ error: 'to must be a valid date-time' });
        return;
      }

      const series = await readGrowthSeries({
        metric: metric as GrowthSeriesMetric | 'installs',
        interval: (interval ?? null) as GrowthSeriesInterval | null,
        from,
        to
      });

      if (!series) {
        res.status(400).json({ error: 'from must be before or equal to to' });
        return;
      }

      res.json({
        metric: series.metric,
        interval: series.interval,
        timezone: series.timezone,
        points: series.points.map((point) => ({
          bucket_start_utc: point.bucketStartUtc,
          bucket_end_utc: point.bucketEndUtc,
          value: point.value
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/cohorts', async (req, res, next) => {
    try {
      const rawLimit = parseSingleQueryValue(req.query.limit);
      if (rawLimit && parsePositiveInteger(rawLimit) === null) {
        res.status(400).json({ error: 'limit must be a positive integer' });
        return;
      }

      const fromDate = parseSingleQueryValue(req.query.from);
      if (fromDate && !isValidDate(fromDate)) {
        res.status(400).json({ error: 'from must be a valid date' });
        return;
      }

      const toDate = parseSingleQueryValue(req.query.to);
      if (toDate && !isValidDate(toDate)) {
        res.status(400).json({ error: 'to must be a valid date' });
        return;
      }

      const limit = parsePositiveInteger(rawLimit) ?? undefined;
      const cohorts = await readGrowthCohorts({
        ...(fromDate ? { fromDate } : {}),
        ...(toDate ? { toDate } : {}),
        ...(limit !== undefined ? { limit } : {})
      });

      res.json({
        timezone: cohorts.timezone,
        rows: cohorts.rows.map((row) => ({
          cohort_date: row.cohortDate,
          registered_users: row.registeredUsers,
          activated_users: row.activatedUsers,
          windows: row.windows.map((window) => ({
            day: window.day,
            eligible_users: window.eligibleUsers,
            retained_users: window.retainedUsers,
            retention_rate_pct: window.retentionRatePct,
            churned_users: window.churnedUsers,
            churn_rate_pct: window.churnRatePct
          }))
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/users/:accountId/journey', async (req, res, next) => {
    try {
      const accountId = req.params.accountId?.trim();
      if (!accountId) {
        res.status(400).json({ error: 'accountId is required' });
        return;
      }

      const journey = await readGrowthUserJourney(accountId);
      if (!journey) {
        res.status(404).json({ error: 'growth user not found' });
        return;
      }

      res.json({
        account_id: journey.accountId,
        user_id: journey.userId,
        source: journey.source,
        registration_at_utc: journey.registrationAtUtc ?? null,
        activation_at_utc: journey.activationAtUtc ?? null,
        events: journey.events.map((event) => ({
          event_type: event.eventType,
          occurred_at_utc: event.occurredAtUtc,
          ...(event.activityDate ? { activity_date: event.activityDate } : {}),
          ...(event.deviceId !== undefined ? { device_id: event.deviceId ?? null } : {}),
          ...(event.orgId !== undefined ? { org_id: event.orgId ?? null } : {}),
          ...(event.machineId !== undefined ? { machine_id: event.machineId ?? null } : {}),
          ...(event.metadata ? { metadata: event.metadata } : {})
        })),
        active_days: journey.activeDays
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
