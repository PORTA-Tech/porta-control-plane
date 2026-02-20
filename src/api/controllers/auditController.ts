import { Router } from 'express';
import { readLedger } from '../../core/auditLedger.js';
import { readOperatorAuditEvents } from '../../core/operatorAudit.js';
import { dispatchOutbox, getOutboxStatus } from '../../core/outbox.js';

type AuditLedgerRow = {
  action: string;
  actor: string;
  timestamp: string;
  cohort: string;
  previous_state: string;
  resulting_state: string;
  correlation_id: string;
};

function readStringMeta(metadata: unknown, key: string): string | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function toLedgerRow(event: {
  eventId: string;
  actorId: string;
  action: string;
  occurredAtUtc: string;
  metadata?: Record<string, string | number | boolean | null>;
}): AuditLedgerRow {
  const metadata = event.metadata;
  return {
    action: event.action,
    actor: event.actorId,
    timestamp: event.occurredAtUtc,
    cohort:
      readStringMeta(metadata, 'cohort') ??
      readStringMeta(metadata, 'cohortId') ??
      readStringMeta(metadata, 'targetCohort') ??
      'n/a',
    previous_state:
      readStringMeta(metadata, 'from') ??
      readStringMeta(metadata, 'fromState') ??
      readStringMeta(metadata, 'previousState') ??
      'n/a',
    resulting_state:
      readStringMeta(metadata, 'to') ??
      readStringMeta(metadata, 'toState') ??
      readStringMeta(metadata, 'resultingState') ??
      'n/a',
    correlation_id: readStringMeta(metadata, 'correlation_id') ?? event.eventId
  };
}

export function createAuditController(): Router {
  const router = Router();

  router.get('/events', (_req, res) => {
    res.json(readLedger());
  });

  router.get('/rollout-events', (req, res) => {
    const limitRaw = Number(req.query.limit ?? 200);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.trunc(limitRaw))) : 200;
    res.json(readOperatorAuditEvents(limit));
  });

  router.get('/ledger-view', (req, res) => {
    const limitRaw = Number(req.query.limit ?? 500);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.trunc(limitRaw))) : 500;
    const actorFilter = typeof req.query.actor === 'string' ? req.query.actor.trim() : '';
    const actionFilter = typeof req.query.action === 'string' ? req.query.action.trim() : '';
    const fromTs = typeof req.query.from === 'string' ? Date.parse(req.query.from) : NaN;
    const toTs = typeof req.query.to === 'string' ? Date.parse(req.query.to) : NaN;

    const rows = readOperatorAuditEvents(limit)
      .map(toLedgerRow)
      .filter((row) => {
        if (actorFilter && row.actor !== actorFilter) return false;
        if (actionFilter && row.action !== actionFilter) return false;

        const at = Date.parse(row.timestamp);
        if (Number.isFinite(fromTs) && at < fromTs) return false;
        if (Number.isFinite(toTs) && at > toTs) return false;

        return true;
      })
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

    res.json(rows);
  });

  router.get('/outbox/status', (_req, res) => {
    res.json(getOutboxStatus());
  });

  router.post('/outbox/dispatch', (req, res) => {
    const maxRaw = Number(req.query.max ?? 100);
    const max = Number.isFinite(maxRaw) ? Math.max(1, Math.min(5000, Math.trunc(maxRaw))) : 100;
    res.json(dispatchOutbox(max));
  });

  return router;
}
