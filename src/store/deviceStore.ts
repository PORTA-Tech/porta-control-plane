import type { DeviceProfile } from '@porta/api-contracts';
import { ensureFleetPersistenceReady, getFleetPersistenceMode, getFleetPool } from './fleetPersistence.js';

const deviceMemoryStore = new Map<string, DeviceProfile>();

export async function upsertDeviceProfile(profile: DeviceProfile): Promise<void> {
  if (getFleetPersistenceMode() === 'memory') {
    deviceMemoryStore.set(profile.deviceId, profile);
    return;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    deviceMemoryStore.set(profile.deviceId, profile);
    return;
  }

  await pool.query(
    `
      INSERT INTO devices (
        device_id,
        org_id,
        machine_name,
        device_display_name,
        platform,
        agent_version,
        status,
        first_seen_at,
        last_seen_at,
        current_account_id,
        revoked_at,
        payload_json,
        created_at,
        updated_at
      ) VALUES (
        $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::uuid, $11::timestamptz, $12::jsonb, $13::timestamptz, $14::timestamptz
      )
      ON CONFLICT (device_id) DO UPDATE SET
        org_id = EXCLUDED.org_id,
        machine_name = EXCLUDED.machine_name,
        device_display_name = EXCLUDED.device_display_name,
        platform = EXCLUDED.platform,
        agent_version = EXCLUDED.agent_version,
        status = EXCLUDED.status,
        first_seen_at = EXCLUDED.first_seen_at,
        last_seen_at = EXCLUDED.last_seen_at,
        current_account_id = EXCLUDED.current_account_id,
        revoked_at = EXCLUDED.revoked_at,
        payload_json = EXCLUDED.payload_json,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at;
    `,
    [
      profile.deviceId,
      profile.orgId ?? null,
      profile.machineName,
      profile.deviceDisplayName,
      profile.platform,
      profile.agentVersion,
      profile.status,
      profile.firstSeenAt,
      profile.lastSeenAt,
      profile.currentAccountId ?? null,
      profile.revokedAt ?? null,
      JSON.stringify(profile),
      profile.createdAt,
      profile.updatedAt
    ]
  );
}

export async function getDeviceProfile(deviceId: string): Promise<DeviceProfile | null> {
  if (getFleetPersistenceMode() === 'memory') {
    return deviceMemoryStore.get(deviceId) ?? null;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return deviceMemoryStore.get(deviceId) ?? null;
  }

  const result = await pool.query<{ payload_json: DeviceProfile }>(
    `
      SELECT payload_json
      FROM devices
      WHERE device_id = $1::uuid
      LIMIT 1;
    `,
    [deviceId]
  );

  return result.rows[0]?.payload_json ?? null;
}

export async function listDeviceProfiles(): Promise<DeviceProfile[]> {
  if (getFleetPersistenceMode() === 'memory') {
    return Array.from(deviceMemoryStore.values()).sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return Array.from(deviceMemoryStore.values()).sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  }

  const result = await pool.query<{ payload_json: DeviceProfile }>(
    `
      SELECT payload_json
      FROM devices
      ORDER BY last_seen_at DESC, device_id ASC;
    `
  );

  return result.rows.map((row) => row.payload_json);
}

export async function listDeviceProfilesForAccount(accountId: string): Promise<DeviceProfile[]> {
  if (getFleetPersistenceMode() === 'memory') {
    return Array.from(deviceMemoryStore.values())
      .filter((profile) => profile.currentAccountId === accountId)
      .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return Array.from(deviceMemoryStore.values())
      .filter((profile) => profile.currentAccountId === accountId)
      .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  }

  const result = await pool.query<{ payload_json: DeviceProfile }>(
    `
      SELECT payload_json
      FROM devices
      WHERE current_account_id = $1::uuid
      ORDER BY last_seen_at DESC, device_id ASC;
    `,
    [accountId]
  );

  return result.rows.map((row) => row.payload_json);
}

export async function listDeviceProfilesForOrganization(orgId: string): Promise<DeviceProfile[]> {
  if (getFleetPersistenceMode() === 'memory') {
    return Array.from(deviceMemoryStore.values())
      .filter((profile) => profile.orgId === orgId)
      .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return Array.from(deviceMemoryStore.values())
      .filter((profile) => profile.orgId === orgId)
      .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  }

  const result = await pool.query<{ payload_json: DeviceProfile }>(
    `
      SELECT payload_json
      FROM devices
      WHERE org_id = $1::uuid
      ORDER BY last_seen_at DESC, device_id ASC;
    `,
    [orgId]
  );

  return result.rows.map((row) => row.payload_json);
}

export async function deleteDeviceProfile(deviceId: string): Promise<void> {
  if (getFleetPersistenceMode() === 'memory') {
    deviceMemoryStore.delete(deviceId);
    return;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    deviceMemoryStore.delete(deviceId);
    return;
  }

  await pool.query(
    `
      DELETE FROM devices
      WHERE device_id = $1::uuid;
    `,
    [deviceId]
  );
}

export function clearDeviceStoreForTests(): void {
  deviceMemoryStore.clear();
}
