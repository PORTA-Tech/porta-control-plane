import type { MachineSummaryReport } from '@porta/api-contracts';
import { ensureFleetPersistenceReady, getFleetPersistenceMode, getFleetPool } from './fleetPersistence.js';

const machineSummaryMemoryStore = new Map<string, MachineSummaryReport>();

export async function upsertMachineSummary(report: MachineSummaryReport): Promise<void> {
  // Stored payload_json intentionally preserves the compatibility transport shape
  // received from the Windows client until focus-episode, pressure, and break
  // overlay fields replace the legacy continuity/overload/break names.
  if (getFleetPersistenceMode() === 'memory') {
    machineSummaryMemoryStore.set(report.machineId, report);
    return;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    machineSummaryMemoryStore.set(report.machineId, report);
    return;
  }

  await pool.query(
    `
      INSERT INTO machine_summaries (
        machine_id,
        machine_name,
        user_name,
        reported_at_utc,
        trust_tier,
        calibration_stage,
        capture_context,
        last_activity_utc,
        payload_json,
        updated_at_utc
      ) VALUES (
        $1, $2, $3, $4::timestamptz, $5, $6, $7, $8::timestamptz, $9::jsonb, NOW()
      )
      ON CONFLICT (machine_id) DO UPDATE SET
        machine_name = EXCLUDED.machine_name,
        user_name = EXCLUDED.user_name,
        reported_at_utc = EXCLUDED.reported_at_utc,
        trust_tier = EXCLUDED.trust_tier,
        calibration_stage = EXCLUDED.calibration_stage,
        capture_context = EXCLUDED.capture_context,
        last_activity_utc = EXCLUDED.last_activity_utc,
        payload_json = EXCLUDED.payload_json,
        updated_at_utc = NOW();
    `,
    [
      report.machineId,
      report.machineName,
      report.userName,
      report.reportedAtUtc,
      report.trustTier,
      report.calibrationStage,
      report.captureContext,
      report.lastActivityUtc ?? null,
      JSON.stringify(report)
    ]
  );
}

export async function getMachineSummary(machineId: string): Promise<MachineSummaryReport | null> {
  if (getFleetPersistenceMode() === 'memory') {
    return machineSummaryMemoryStore.get(machineId) ?? null;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return machineSummaryMemoryStore.get(machineId) ?? null;
  }

  const result = await pool.query<{ payload_json: MachineSummaryReport }>(
    `
      SELECT payload_json
      FROM machine_summaries
      WHERE machine_id = $1
      LIMIT 1;
    `,
    [machineId]
  );

  return result.rows[0]?.payload_json ?? null;
}

export async function listMachineSummaries(): Promise<MachineSummaryReport[]> {
  if (getFleetPersistenceMode() === 'memory') {
    return Array.from(machineSummaryMemoryStore.values()).sort(
      (a, b) => Date.parse(b.reportedAtUtc) - Date.parse(a.reportedAtUtc)
    );
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return Array.from(machineSummaryMemoryStore.values()).sort(
      (a, b) => Date.parse(b.reportedAtUtc) - Date.parse(a.reportedAtUtc)
    );
  }

  const result = await pool.query<{ payload_json: MachineSummaryReport }>(
    `
      SELECT payload_json
      FROM machine_summaries
      ORDER BY reported_at_utc DESC, machine_id ASC;
    `
  );

  return result.rows.map((row: { payload_json: MachineSummaryReport }) => row.payload_json);
}

export function clearMachineSummaryStoreForTests(): void {
  machineSummaryMemoryStore.clear();
}
