/**
 * Clears a device's stored credential so it can bootstrap a fresh one on next registration.
 *
 * Why this exists: a credential is issued exactly once, so a device whose plaintext was lost --
 * handed to an agent build that could not store it, or a machine restored from an image -- is
 * stranded with a hash the agent cannot satisfy. Clearing the hash returns it to "linked,
 * uncredentialed", which the register bootstrap then heals with nobody present.
 *
 * Reads only, then writes one row, and prints the before/after so the change is visible.
 * It never prints or handles a secret: only the hash is stored server-side, and this nulls it.
 *
 * Usage (from the porta-control-plane directory, which is where `pg` is installed):
 *   $env:DATABASE_URL = "<connection string>"
 *   node scripts/clear-device-credential.mjs <deviceId>
 */
import pg from 'pg';

const deviceId = process.argv[2];
const connectionString = process.env.DATABASE_URL;

if (!deviceId) {
  console.error('Usage: node scripts/clear-device-credential.mjs <deviceId>');
  process.exit(1);
}

if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)) {
  console.error(`Refusing to run: "${deviceId}" is not a UUID.`);
  process.exit(1);
}

if (!connectionString) {
  console.error('DATABASE_URL is not set in this shell.');
  process.exit(1);
}

const client = new pg.Client({
  connectionString,
  ssl: connectionString.includes('localhost') ? undefined : { rejectUnauthorized: false }
});

try {
  await client.connect();

  const before = await client.query(
    `SELECT device_id, machine_name, current_account_id, status,
            device_secret_hash IS NOT NULL AS has_credential, device_secret_created_at_utc, last_seen_at
     FROM devices WHERE device_id = $1::uuid;`,
    [deviceId]
  );

  if (before.rows.length === 0) {
    console.error(`No device row for ${deviceId}. Nothing changed.`);
    process.exit(1);
  }

  console.log('BEFORE:', before.rows[0]);

  if (!before.rows[0].has_credential) {
    console.log('\nAlready has no credential — nothing to clear. Exiting without writing.');
    process.exit(0);
  }

  const updated = await client.query(
    `UPDATE devices SET device_secret_hash = NULL, device_secret_created_at_utc = NULL
     WHERE device_id = $1::uuid;`,
    [deviceId]
  );
  console.log(`\nUPDATE ${updated.rowCount}`);

  const after = await client.query(
    `SELECT device_id, current_account_id, status, device_secret_hash IS NOT NULL AS has_credential
     FROM devices WHERE device_id = $1::uuid;`,
    [deviceId]
  );
  console.log('AFTER :', after.rows[0]);
  console.log('\nThe device will bootstrap a new credential on its next registration.');
} catch (error) {
  console.error('Failed:', error instanceof Error ? error.message : error);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
