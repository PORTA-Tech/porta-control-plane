import type { MachineSummaryReport } from '@porta/api-contracts';
import { ensureFleetPersistenceReady, getFleetPersistenceMode, getFleetPool } from './fleetPersistence.js';

const machineSummaryMemoryStore = new Map<string, MachineSummaryReport>();

function withCanonicalFocusEpisode(report: MachineSummaryReport): MachineSummaryReport {
  const focusEpisodeQuality = Number.isFinite(report.focusEpisodeQuality)
    ? report.focusEpisodeQuality
    : report.taskContinuityScore;
  const focusEpisodeSeconds = Number.isFinite(report.focusEpisodeSeconds)
    ? report.focusEpisodeSeconds
    : report.taskContinuitySeconds;
  const focusEpisodeState = (typeof report.focusEpisodeState === 'string' && report.focusEpisodeState.trim().length > 0)
    ? report.focusEpisodeState
    : report.continuityState;

  return {
    ...report,
    focusEpisodeQuality,
    focusEpisodeSeconds,
    focusEpisodeState,
    taskContinuityScore: Number.isFinite(report.taskContinuityScore) ? report.taskContinuityScore : focusEpisodeQuality,
    taskContinuitySeconds: Number.isFinite(report.taskContinuitySeconds) ? report.taskContinuitySeconds : focusEpisodeSeconds,
    continuityState: (typeof report.continuityState === 'string' && report.continuityState.trim().length > 0)
      ? report.continuityState
      : focusEpisodeState
  };
}

export async function upsertMachineSummary(report: MachineSummaryReport): Promise<void> {
  // Stored payload_json preserves the canonical focus-episode fields and keeps
  // the legacy continuity aliases alongside them for migration safety.
  const normalized = withCanonicalFocusEpisode(report);
  if (getFleetPersistenceMode() === 'memory') {
    machineSummaryMemoryStore.set(normalized.machineId, normalized);
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
      normalized.machineId,
      normalized.machineName,
      normalized.userName,
      normalized.reportedAtUtc,
      normalized.trustTier,
      normalized.calibrationStage,
      normalized.captureContext,
      normalized.lastActivityUtc ?? null,
      JSON.stringify(normalized)
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

  const row = result.rows[0]?.payload_json ?? null;
  return row ? withCanonicalFocusEpisode(row) : null;
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

  return result.rows.map((row: { payload_json: MachineSummaryReport }) => withCanonicalFocusEpisode(row.payload_json));
}

export function clearMachineSummaryStoreForTests(): void {
  machineSummaryMemoryStore.clear();
}
