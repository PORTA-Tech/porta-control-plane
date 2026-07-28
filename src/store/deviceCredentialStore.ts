import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ensureFleetPersistenceReady, getFleetPersistenceMode, getFleetPool } from './fleetPersistence.js';

/**
 * Per-device credentials (Stage 3).
 *
 * Kept out of deviceStore on purpose: DeviceProfile is serialised wholesale into
 * devices.payload_json and handed to the console and the Control Center. A secret hash
 * must never ride along in a device view, so it lives in its own columns and its own module.
 */

export interface DeviceCredentialRecord {
  secretHash: string;
  createdAtUtc: string;
}

const credentialMemoryStore = new Map<string, DeviceCredentialRecord>();

export function generateDeviceSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function hashDeviceSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Constant-time compare. Length is checked first because timingSafeEqual throws on a
 * length mismatch, and both hashes are fixed-length hex so the length itself leaks nothing.
 */
export function deviceSecretMatches(secret: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashDeviceSecret(secret), 'utf8');
  const stored = Buffer.from(storedHash, 'utf8');
  if (candidate.length !== stored.length) {
    return false;
  }

  return timingSafeEqual(candidate, stored);
}

/**
 * Issues a fresh secret for a device and returns the plaintext exactly once. Re-issuing
 * overwrites the previous hash, so this doubles as the revocation story: rotate and the
 * old credential stops working immediately.
 */
export async function issueDeviceSecret(deviceId: string): Promise<{ secret: string; record: DeviceCredentialRecord }> {
  const secret = generateDeviceSecret();
  const record: DeviceCredentialRecord = {
    secretHash: hashDeviceSecret(secret),
    createdAtUtc: new Date().toISOString()
  };

  await writeDeviceCredential(deviceId, record);
  return { secret, record };
}

async function writeDeviceCredential(deviceId: string, record: DeviceCredentialRecord): Promise<void> {
  if (getFleetPersistenceMode() === 'memory') {
    credentialMemoryStore.set(deviceId, record);
    return;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    credentialMemoryStore.set(deviceId, record);
    return;
  }

  await pool.query(
    `
      UPDATE devices
      SET device_secret_hash = $2,
          device_secret_created_at_utc = $3::timestamptz,
          updated_at = $3::timestamptz
      WHERE device_id = $1::uuid;
    `,
    [deviceId, record.secretHash, record.createdAtUtc]
  );
}

export async function getDeviceCredential(deviceId: string): Promise<DeviceCredentialRecord | null> {
  if (getFleetPersistenceMode() === 'memory') {
    return credentialMemoryStore.get(deviceId) ?? null;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return credentialMemoryStore.get(deviceId) ?? null;
  }

  const result = await pool.query<{ device_secret_hash: string | null; device_secret_created_at_utc: Date | null }>(
    `
      SELECT device_secret_hash, device_secret_created_at_utc
      FROM devices
      WHERE device_id = $1::uuid
      LIMIT 1;
    `,
    [deviceId]
  );

  const row = result.rows[0];
  if (!row?.device_secret_hash) {
    return null;
  }

  return {
    secretHash: row.device_secret_hash,
    createdAtUtc: row.device_secret_created_at_utc?.toISOString() ?? new Date(0).toISOString()
  };
}

export async function clearDeviceCredential(deviceId: string): Promise<void> {
  if (getFleetPersistenceMode() === 'memory') {
    credentialMemoryStore.delete(deviceId);
    return;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    credentialMemoryStore.delete(deviceId);
    return;
  }

  await pool.query(
    `
      UPDATE devices
      SET device_secret_hash = NULL,
          device_secret_created_at_utc = NULL
      WHERE device_id = $1::uuid;
    `,
    [deviceId]
  );
}

export function clearDeviceCredentialStoreForTests(): void {
  credentialMemoryStore.clear();
}
