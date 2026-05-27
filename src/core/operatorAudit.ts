import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AuditEvent } from '@porta/api-contracts';
import { enqueueAuditOutboxEvent } from './outbox.js';

const auditPath = path.resolve('.data', 'operator-audit.ndjson');

export function appendOperatorAuditEvent(
  actorId: string,
  action: string,
  target: string,
  metadata?: AuditEvent['metadata']
): AuditEvent {
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  const event: AuditEvent = {
    eventId: crypto.randomUUID(),
    actorId,
    action,
    target,
    occurredAtUtc: new Date().toISOString(),
    ...(metadata !== undefined ? { metadata } : {})
  };

  fs.appendFileSync(auditPath, JSON.stringify(event) + '\n');
  enqueueAuditOutboxEvent(event);
  return event;
}

export function readOperatorAuditEvents(limit = 200): AuditEvent[] {
  if (!fs.existsSync(auditPath)) {
    return [];
  }

  const events = fs
    .readFileSync(auditPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditEvent);

  return events.slice(Math.max(0, events.length - Math.max(1, limit)));
}
