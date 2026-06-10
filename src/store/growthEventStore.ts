import { randomUUID } from 'node:crypto';
import type { GrowthUserJourneyEventType } from '@porta/api-contracts';
import { ensureFleetPersistenceReady, getFleetPersistenceMode, getFleetPool } from './fleetPersistence.js';

export type GrowthEventType = GrowthUserJourneyEventType | 'machine_installed';
export type GrowthEventMetadata = Record<string, string | number | boolean | null>;

export interface GrowthEventRecord {
  eventId: string;
  eventKey: string;
  eventType: GrowthEventType;
  accountId?: string | null;
  userId?: string | null;
  deviceId?: string | null;
  orgId?: string | null;
  machineId?: string | null;
  occurredAtUtc: string;
  source: string;
  activityDate?: string | null;
  metadata?: GrowthEventMetadata;
  createdAtUtc: string;
}

export interface AppendGrowthEventInput {
  eventKey: string;
  eventType: GrowthEventType;
  accountId?: string | null;
  userId?: string | null;
  deviceId?: string | null;
  orgId?: string | null;
  machineId?: string | null;
  occurredAtUtc: string;
  source: string;
  activityDate?: string | null;
  metadata?: GrowthEventMetadata;
  createdAtUtc?: string;
}

interface GrowthEventRow {
  event_id: string;
  event_key: string;
  event_type: GrowthEventType;
  account_id: string | null;
  user_id: string | null;
  device_id: string | null;
  org_id: string | null;
  machine_id: string | null;
  occurred_at_utc: string;
  source: string;
  payload_json: {
    activityDate?: string | null;
    metadata?: GrowthEventMetadata;
  } | null;
  created_at_utc: string;
}

const growthEventMemoryStore = new Map<string, GrowthEventRecord>();

function normalizeTimestamp(input: string): string {
  const parsed = Date.parse(input);
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}

function normalizeActivityDate(input: string | null | undefined): string | null {
  const trimmed = input?.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}

function compareGrowthEvents(left: GrowthEventRecord, right: GrowthEventRecord): number {
  const occurred = Date.parse(left.occurredAtUtc) - Date.parse(right.occurredAtUtc);
  if (occurred !== 0) {
    return occurred;
  }
  return left.eventKey.localeCompare(right.eventKey);
}

function mapGrowthEventRow(row: GrowthEventRow): GrowthEventRecord {
  return {
    eventId: row.event_id,
    eventKey: row.event_key,
    eventType: row.event_type,
    ...(row.account_id ? { accountId: row.account_id } : { accountId: null }),
    ...(row.user_id ? { userId: row.user_id } : { userId: null }),
    ...(row.device_id ? { deviceId: row.device_id } : { deviceId: null }),
    ...(row.org_id ? { orgId: row.org_id } : { orgId: null }),
    ...(row.machine_id ? { machineId: row.machine_id } : { machineId: null }),
    occurredAtUtc: row.occurred_at_utc,
    source: row.source,
    ...(row.payload_json?.activityDate ? { activityDate: row.payload_json.activityDate } : {}),
    ...(row.payload_json?.metadata ? { metadata: row.payload_json.metadata } : {}),
    createdAtUtc: row.created_at_utc
  };
}

function toGrowthEventRecord(input: AppendGrowthEventInput): GrowthEventRecord {
  return {
    eventId: randomUUID(),
    eventKey: input.eventKey,
    eventType: input.eventType,
    ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
    ...(input.userId !== undefined ? { userId: input.userId } : {}),
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    ...(input.orgId !== undefined ? { orgId: input.orgId } : {}),
    ...(input.machineId !== undefined ? { machineId: input.machineId } : {}),
    occurredAtUtc: normalizeTimestamp(input.occurredAtUtc),
    source: input.source,
    ...(normalizeActivityDate(input.activityDate) ? { activityDate: normalizeActivityDate(input.activityDate) } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    createdAtUtc: normalizeTimestamp(input.createdAtUtc ?? new Date().toISOString())
  };
}

function buildPayload(record: GrowthEventRecord): { activityDate?: string | null; metadata?: GrowthEventMetadata } {
  return {
    ...(record.activityDate ? { activityDate: record.activityDate } : {}),
    ...(record.metadata ? { metadata: record.metadata } : {})
  };
}

export async function getGrowthEventByKey(eventKey: string): Promise<GrowthEventRecord | null> {
  if (getFleetPersistenceMode() === 'memory') {
    return growthEventMemoryStore.get(eventKey) ?? null;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return growthEventMemoryStore.get(eventKey) ?? null;
  }

  const result = await pool.query<GrowthEventRow>(
    `
      SELECT
        event_id,
        event_key,
        event_type,
        account_id,
        user_id,
        device_id,
        org_id,
        machine_id,
        occurred_at_utc,
        source,
        payload_json,
        created_at_utc
      FROM growth_events
      WHERE event_key = $1
      LIMIT 1;
    `,
    [eventKey]
  );

  return result.rows[0] ? mapGrowthEventRow(result.rows[0]) : null;
}

export async function appendGrowthEvent(input: AppendGrowthEventInput): Promise<GrowthEventRecord> {
  const record = toGrowthEventRecord(input);

  if (getFleetPersistenceMode() === 'memory') {
    const existing = growthEventMemoryStore.get(record.eventKey);
    if (existing) {
      return existing;
    }

    growthEventMemoryStore.set(record.eventKey, record);
    return record;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    const existing = growthEventMemoryStore.get(record.eventKey);
    if (existing) {
      return existing;
    }

    growthEventMemoryStore.set(record.eventKey, record);
    return record;
  }

  const inserted = await pool.query<GrowthEventRow>(
    `
      INSERT INTO growth_events (
        event_id,
        event_key,
        event_type,
        account_id,
        user_id,
        device_id,
        org_id,
        machine_id,
        occurred_at_utc,
        source,
        payload_json,
        created_at_utc
      ) VALUES (
        $1::uuid, $2, $3, $4::uuid, $5, $6::uuid, $7::uuid, $8, $9::timestamptz, $10, $11::jsonb, $12::timestamptz
      )
      ON CONFLICT (event_key) DO NOTHING
      RETURNING
        event_id,
        event_key,
        event_type,
        account_id,
        user_id,
        device_id,
        org_id,
        machine_id,
        occurred_at_utc,
        source,
        payload_json,
        created_at_utc;
    `,
    [
      record.eventId,
      record.eventKey,
      record.eventType,
      record.accountId ?? null,
      record.userId ?? null,
      record.deviceId ?? null,
      record.orgId ?? null,
      record.machineId ?? null,
      record.occurredAtUtc,
      record.source,
      JSON.stringify(buildPayload(record)),
      record.createdAtUtc
    ]
  );

  if (inserted.rows[0]) {
    return mapGrowthEventRow(inserted.rows[0]);
  }

  const existing = await getGrowthEventByKey(record.eventKey);
  if (existing) {
    return existing;
  }

  throw new Error(`Growth event with key ${record.eventKey} could not be persisted.`);
}

export async function listGrowthEvents(): Promise<GrowthEventRecord[]> {
  if (getFleetPersistenceMode() === 'memory') {
    return Array.from(growthEventMemoryStore.values()).sort(compareGrowthEvents);
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return Array.from(growthEventMemoryStore.values()).sort(compareGrowthEvents);
  }

  const result = await pool.query<GrowthEventRow>(
    `
      SELECT
        event_id,
        event_key,
        event_type,
        account_id,
        user_id,
        device_id,
        org_id,
        machine_id,
        occurred_at_utc,
        source,
        payload_json,
        created_at_utc
      FROM growth_events
      ORDER BY occurred_at_utc ASC, event_key ASC;
    `
  );

  return result.rows.map(mapGrowthEventRow);
}

export async function listGrowthEventsForAccount(accountId: string): Promise<GrowthEventRecord[]> {
  if (getFleetPersistenceMode() === 'memory') {
    return Array.from(growthEventMemoryStore.values())
      .filter((record) => record.accountId === accountId)
      .sort(compareGrowthEvents);
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return Array.from(growthEventMemoryStore.values())
      .filter((record) => record.accountId === accountId)
      .sort(compareGrowthEvents);
  }

  const result = await pool.query<GrowthEventRow>(
    `
      SELECT
        event_id,
        event_key,
        event_type,
        account_id,
        user_id,
        device_id,
        org_id,
        machine_id,
        occurred_at_utc,
        source,
        payload_json,
        created_at_utc
      FROM growth_events
      WHERE account_id = $1::uuid
      ORDER BY occurred_at_utc ASC, event_key ASC;
    `,
    [accountId]
  );

  return result.rows.map(mapGrowthEventRow);
}

export function clearGrowthEventStoreForTests(): void {
  growthEventMemoryStore.clear();
}
