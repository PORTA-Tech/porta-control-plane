import { ensureFleetPersistenceReady, getFleetPersistenceMode, getFleetPool } from './fleetPersistence.js';

export interface UptimeSample {
  machineId: string;
  sampledAtUtc: string;
  agentRunning: boolean;
  userSessionConnected: boolean;
  activityDetected: boolean;
}

const MAX_MEMORY_SAMPLES = 20_000;
const memorySamples: UptimeSample[] = [];

export async function appendUptimeSample(sample: UptimeSample): Promise<void> {
  try {
    if (getFleetPersistenceMode() === 'memory') {
      if (memorySamples.length >= MAX_MEMORY_SAMPLES) {
        memorySamples.splice(0, 1000);
      }
      memorySamples.push(sample);
      return;
    }

    await ensureFleetPersistenceReady();
    const pool = getFleetPool();
    if (!pool) {
      if (memorySamples.length >= MAX_MEMORY_SAMPLES) {
        memorySamples.splice(0, 1000);
      }
      memorySamples.push(sample);
      return;
    }

    await pool.query(
      `INSERT INTO machine_uptime_samples
         (machine_id, sampled_at_utc, agent_running, user_session_connected, activity_detected)
       VALUES ($1, $2::timestamptz, $3, $4, $5)
       ON CONFLICT (machine_id, sampled_at_utc) DO NOTHING`,
      [
        sample.machineId,
        sample.sampledAtUtc,
        sample.agentRunning,
        sample.userSessionConnected,
        sample.activityDetected,
      ]
    );
  } catch (error) {
    console.error('[uptime] sample write failed:', error);
  }
}

export async function listUptimeSamples(machineId: string, sinceUtc: string): Promise<UptimeSample[]> {
  if (getFleetPersistenceMode() === 'memory') {
    return memorySamples
      .filter((s) => s.machineId === machineId && s.sampledAtUtc >= sinceUtc)
      .sort((a, b) => a.sampledAtUtc.localeCompare(b.sampledAtUtc));
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return memorySamples
      .filter((s) => s.machineId === machineId && s.sampledAtUtc >= sinceUtc)
      .sort((a, b) => a.sampledAtUtc.localeCompare(b.sampledAtUtc));
  }

  const result = await pool.query<{
    machine_id: string;
    sampled_at_utc: Date | string;
    agent_running: boolean;
    user_session_connected: boolean;
    activity_detected: boolean;
  }>(
    `SELECT machine_id, sampled_at_utc, agent_running, user_session_connected, activity_detected
     FROM machine_uptime_samples
     WHERE machine_id = $1 AND sampled_at_utc >= $2::timestamptz
     ORDER BY sampled_at_utc ASC`,
    [machineId, sinceUtc]
  );

  return result.rows.map((row) => ({
    machineId: row.machine_id,
    sampledAtUtc: row.sampled_at_utc instanceof Date ? row.sampled_at_utc.toISOString() : String(row.sampled_at_utc),
    agentRunning: row.agent_running,
    userSessionConnected: row.user_session_connected,
    activityDetected: row.activity_detected,
  }));
}
