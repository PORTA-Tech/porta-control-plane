import type { MachineActionEvent } from '@porta/api-contracts';
import { ensureFleetPersistenceReady, getFleetPersistenceMode, getFleetPool } from './fleetPersistence.js';

const machineActionMemoryStore: MachineActionEvent[] = [];

export async function appendMachineActionEvent(event: MachineActionEvent): Promise<void> {
  if (getFleetPersistenceMode() === 'memory') {
    upsertMemoryEvent(event);
    return;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    upsertMemoryEvent(event);
    return;
  }

  await pool.query(
    `
      INSERT INTO machine_action_events (
        machine_id,
        user_name,
        intervention_id,
        action,
        action_category,
        decision_state,
        execution_state,
        verified_state,
        timestamp_utc,
        applied_at_utc,
        error_code,
        policy_id,
        what_changed,
        how_to_undo,
        payload_json
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11, $12, $13, $14, $15::jsonb
      )
      ON CONFLICT (machine_id, intervention_id, timestamp_utc, action, execution_state, verified_state) DO UPDATE SET
        user_name = EXCLUDED.user_name,
        action_category = EXCLUDED.action_category,
        decision_state = EXCLUDED.decision_state,
        applied_at_utc = EXCLUDED.applied_at_utc,
        error_code = EXCLUDED.error_code,
        policy_id = EXCLUDED.policy_id,
        what_changed = EXCLUDED.what_changed,
        how_to_undo = EXCLUDED.how_to_undo,
        payload_json = EXCLUDED.payload_json;
    `,
    [
      event.machineId,
      event.userName,
      event.interventionId,
      event.action,
      event.actionCategory,
      event.decisionState,
      event.executionState,
      event.verifiedState,
      event.timestampUtc,
      event.appliedAtUtc ?? null,
      event.errorCode ?? null,
      event.policyId,
      event.whatChanged ?? null,
      event.howToUndo ?? null,
      JSON.stringify(event)
    ]
  );
}

export async function listRecentMachineActionEvents(limit = 100): Promise<MachineActionEvent[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 1000));

  if (getFleetPersistenceMode() === 'memory') {
    return [...machineActionMemoryStore]
      .sort((a, b) => Date.parse(b.timestampUtc) - Date.parse(a.timestampUtc))
      .slice(0, boundedLimit);
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return [...machineActionMemoryStore]
      .sort((a, b) => Date.parse(b.timestampUtc) - Date.parse(a.timestampUtc))
      .slice(0, boundedLimit);
  }

  const result = await pool.query<{ payload_json: MachineActionEvent }>(
    `
      SELECT payload_json
      FROM machine_action_events
      ORDER BY timestamp_utc DESC, id DESC
      LIMIT $1;
    `,
    [boundedLimit]
  );

  return result.rows.map((row: { payload_json: MachineActionEvent }) => row.payload_json);
}

export async function listMachineActionEventsForMachine(machineId: string, limit = 100): Promise<MachineActionEvent[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 1000));

  if (getFleetPersistenceMode() === 'memory') {
    return machineActionMemoryStore
      .filter((entry) => entry.machineId === machineId)
      .sort((a, b) => Date.parse(b.timestampUtc) - Date.parse(a.timestampUtc))
      .slice(0, boundedLimit);
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return machineActionMemoryStore
      .filter((entry) => entry.machineId === machineId)
      .sort((a, b) => Date.parse(b.timestampUtc) - Date.parse(a.timestampUtc))
      .slice(0, boundedLimit);
  }

  const result = await pool.query<{ payload_json: MachineActionEvent }>(
    `
      SELECT payload_json
      FROM machine_action_events
      WHERE machine_id = $1
      ORDER BY timestamp_utc DESC, id DESC
      LIMIT $2;
    `,
    [machineId, boundedLimit]
  );

  return result.rows.map((row: { payload_json: MachineActionEvent }) => row.payload_json);
}

export function clearMachineActionStoreForTests(): void {
  machineActionMemoryStore.length = 0;
}

function upsertMemoryEvent(event: MachineActionEvent): void {
  const index = machineActionMemoryStore.findIndex(
    (entry) =>
      entry.machineId === event.machineId &&
      entry.interventionId === event.interventionId &&
      entry.timestampUtc === event.timestampUtc &&
      entry.action === event.action &&
      entry.executionState === event.executionState &&
      entry.verifiedState === event.verifiedState
  );

  if (index >= 0) {
    machineActionMemoryStore[index] = event;
    return;
  }

  machineActionMemoryStore.push(event);
}
