import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AuditEvent } from '@porta/api-contracts';

const outboxPath = path.resolve('.data', 'outbox.ndjson');
const deliveredPath = path.resolve('.data', 'outbox-delivered.ndjson');
const dispatchLogPath = path.resolve('.data', 'outbox-dispatch.ndjson');

export interface OutboxRecord {
  outboxId: string;
  dedupeKey: string;
  topic: string;
  createdAtUtc: string;
  payload: Record<string, unknown>;
}

export interface OutboxDispatchSummary {
  scanned: number;
  delivered: number;
  skipped: number;
  failed: number;
  lastError?: string;
}

export type OutboxDispatchHandler = (record: OutboxRecord) => void;

function ensureDataDir(): void {
  fs.mkdirSync(path.dirname(outboxPath), { recursive: true });
}

function appendLine(filePath: string, line: string): void {
  ensureDataDir();
  fs.appendFileSync(filePath, line + '\n');
}

export function appendOutboxRecord(record: OutboxRecord): OutboxRecord {
  appendLine(outboxPath, JSON.stringify(record));
  return record;
}

export function enqueueAuditOutboxEvent(event: AuditEvent): OutboxRecord {
  return appendOutboxRecord({
    outboxId: crypto.randomUUID(),
    dedupeKey: event.eventId,
    topic: 'audit.event',
    createdAtUtc: new Date().toISOString(),
    payload: event as unknown as Record<string, unknown>
  });
}

export function readOutboxRecords(): OutboxRecord[] {
  if (!fs.existsSync(outboxPath)) {
    return [];
  }

  return fs
    .readFileSync(outboxPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as OutboxRecord);
}

export function readDeliveredDedupeKeys(): Set<string> {
  if (!fs.existsSync(deliveredPath)) {
    return new Set<string>();
  }

  const keys = fs
    .readFileSync(deliveredPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return new Set(keys);
}

function markDelivered(dedupeKey: string): void {
  appendLine(deliveredPath, dedupeKey);
}

function defaultDispatch(record: OutboxRecord): void {
  appendLine(dispatchLogPath, JSON.stringify({ dispatchedAtUtc: new Date().toISOString(), ...record }));
}

export function dispatchOutbox(
  maxRecords = 100,
  dispatchHandler: OutboxDispatchHandler = defaultDispatch
): OutboxDispatchSummary {
  const summary: OutboxDispatchSummary = {
    scanned: 0,
    delivered: 0,
    skipped: 0,
    failed: 0
  };

  const records = readOutboxRecords();
  const deliveredKeys = readDeliveredDedupeKeys();
  const limit = Math.max(1, maxRecords);

  for (const record of records) {
    if (summary.scanned >= limit) {
      break;
    }
    summary.scanned++;

    if (deliveredKeys.has(record.dedupeKey)) {
      summary.skipped++;
      continue;
    }

    try {
      dispatchHandler(record);
      markDelivered(record.dedupeKey);
      deliveredKeys.add(record.dedupeKey);
      summary.delivered++;
    } catch (error) {
      summary.failed++;
      summary.lastError = error instanceof Error ? error.message : String(error);
      break;
    }
  }

  return summary;
}

export function getOutboxStatus(): { queued: number; delivered: number; pending: number } {
  const records = readOutboxRecords();
  const delivered = readDeliveredDedupeKeys();
  const pending = records.filter((record) => !delivered.has(record.dedupeKey)).length;

  return {
    queued: records.length,
    delivered: delivered.size,
    pending
  };
}
