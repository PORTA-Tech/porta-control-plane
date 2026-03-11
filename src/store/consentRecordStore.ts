import type { ConsentRecord } from '@porta/api-contracts';
import { ensureFleetPersistenceReady, getFleetPersistenceMode, getFleetPool } from './fleetPersistence.js';

const consentMemoryStore = new Map<string, ConsentRecord>();

export async function upsertConsentRecord(record: ConsentRecord): Promise<void> {
  if (getFleetPersistenceMode() === 'memory') {
    consentMemoryStore.set(record.consentId, record);
    return;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    consentMemoryStore.set(record.consentId, record);
    return;
  }

  await pool.query(
    `
      INSERT INTO consent_records (
        consent_id,
        scope,
        account_id,
        device_id,
        org_id,
        consent_version,
        consent_state,
        telemetry_level,
        consented_at,
        payload_json,
        updated_at
      ) VALUES (
        $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9::timestamptz, $10::jsonb, $11::timestamptz
      )
      ON CONFLICT (consent_id) DO UPDATE SET
        scope = EXCLUDED.scope,
        account_id = EXCLUDED.account_id,
        device_id = EXCLUDED.device_id,
        org_id = EXCLUDED.org_id,
        consent_version = EXCLUDED.consent_version,
        consent_state = EXCLUDED.consent_state,
        telemetry_level = EXCLUDED.telemetry_level,
        consented_at = EXCLUDED.consented_at,
        payload_json = EXCLUDED.payload_json,
        updated_at = EXCLUDED.updated_at;
    `,
    [
      record.consentId,
      record.scope,
      record.accountId ?? null,
      record.deviceId ?? null,
      record.orgId ?? null,
      record.consentVersion,
      record.consentState,
      record.telemetryLevel ?? null,
      record.consentedAt,
      JSON.stringify(record),
      record.updatedAt
    ]
  );
}

export async function getConsentRecord(consentId: string): Promise<ConsentRecord | null> {
  if (getFleetPersistenceMode() === 'memory') {
    return consentMemoryStore.get(consentId) ?? null;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return consentMemoryStore.get(consentId) ?? null;
  }

  const result = await pool.query<{ payload_json: ConsentRecord }>(
    `
      SELECT payload_json
      FROM consent_records
      WHERE consent_id = $1::uuid
      LIMIT 1;
    `,
    [consentId]
  );

  return result.rows[0]?.payload_json ?? null;
}

export async function listConsentRecords(): Promise<ConsentRecord[]> {
  if (getFleetPersistenceMode() === 'memory') {
    return Array.from(consentMemoryStore.values()).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return Array.from(consentMemoryStore.values()).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  const result = await pool.query<{ payload_json: ConsentRecord }>(
    `
      SELECT payload_json
      FROM consent_records
      ORDER BY updated_at DESC, consent_id ASC;
    `
  );

  return result.rows.map((row) => row.payload_json);
}

export async function listConsentRecordsForAccount(accountId: string): Promise<ConsentRecord[]> {
  if (getFleetPersistenceMode() === 'memory') {
    return Array.from(consentMemoryStore.values())
      .filter((record) => record.accountId === accountId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return Array.from(consentMemoryStore.values())
      .filter((record) => record.accountId === accountId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  const result = await pool.query<{ payload_json: ConsentRecord }>(
    `
      SELECT payload_json
      FROM consent_records
      WHERE account_id = $1::uuid
      ORDER BY updated_at DESC, consent_id ASC;
    `,
    [accountId]
  );

  return result.rows.map((row) => row.payload_json);
}

export async function listConsentRecordsForDevice(deviceId: string): Promise<ConsentRecord[]> {
  if (getFleetPersistenceMode() === 'memory') {
    return Array.from(consentMemoryStore.values())
      .filter((record) => record.deviceId === deviceId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return Array.from(consentMemoryStore.values())
      .filter((record) => record.deviceId === deviceId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  const result = await pool.query<{ payload_json: ConsentRecord }>(
    `
      SELECT payload_json
      FROM consent_records
      WHERE device_id = $1::uuid
      ORDER BY updated_at DESC, consent_id ASC;
    `,
    [deviceId]
  );

  return result.rows.map((row) => row.payload_json);
}

export async function listConsentRecordsForOrganization(orgId: string): Promise<ConsentRecord[]> {
  if (getFleetPersistenceMode() === 'memory') {
    return Array.from(consentMemoryStore.values())
      .filter((record) => record.orgId === orgId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return Array.from(consentMemoryStore.values())
      .filter((record) => record.orgId === orgId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  const result = await pool.query<{ payload_json: ConsentRecord }>(
    `
      SELECT payload_json
      FROM consent_records
      WHERE org_id = $1::uuid
      ORDER BY updated_at DESC, consent_id ASC;
    `,
    [orgId]
  );

  return result.rows.map((row) => row.payload_json);
}

export async function deleteConsentRecord(consentId: string): Promise<void> {
  if (getFleetPersistenceMode() === 'memory') {
    consentMemoryStore.delete(consentId);
    return;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    consentMemoryStore.delete(consentId);
    return;
  }

  await pool.query(
    `
      DELETE FROM consent_records
      WHERE consent_id = $1::uuid;
    `,
    [consentId]
  );
}

export function clearConsentRecordStoreForTests(): void {
  consentMemoryStore.clear();
}
