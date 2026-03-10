import { Pool } from 'pg';

export type FleetPersistenceMode = 'postgres' | 'memory';

const databaseUrl = process.env.PORTA_CONTROL_PLANE_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || '';

let pool: Pool | null = null;
let schemaReadyPromise: Promise<void> | null = null;

function isSslRequired(connectionString: string): boolean {
  return /render\.com/i.test(connectionString) || /sslmode=require/i.test(connectionString);
}

export function getFleetPersistenceMode(): FleetPersistenceMode {
  return databaseUrl.length > 0 ? 'postgres' : 'memory';
}

export function getFleetDatabaseUrl(): string | null {
  return databaseUrl.length > 0 ? databaseUrl : null;
}

export function getFleetPool(): Pool | null {
  if (getFleetPersistenceMode() !== 'postgres') {
    return null;
  }

  if (pool) {
    return pool;
  }

  pool = new Pool({
    connectionString: databaseUrl,
    ssl: isSslRequired(databaseUrl) ? { rejectUnauthorized: false } : undefined
  });

  return pool;
}

export async function ensureFleetPersistenceReady(): Promise<void> {
  if (getFleetPersistenceMode() !== 'postgres') {
    return;
  }

  if (!schemaReadyPromise) {
    schemaReadyPromise = initializeFleetSchema();
  }

  await schemaReadyPromise;
}

async function initializeFleetSchema(): Promise<void> {
  const activePool = getFleetPool();
  if (!activePool) {
    return;
  }

  await activePool.query(`
    CREATE TABLE IF NOT EXISTS machine_summaries (
      machine_id TEXT PRIMARY KEY,
      machine_name TEXT NOT NULL,
      user_name TEXT NOT NULL,
      reported_at_utc TIMESTAMPTZ NOT NULL,
      trust_tier TEXT NOT NULL,
      calibration_stage TEXT NOT NULL,
      capture_context TEXT NOT NULL,
      last_activity_utc TIMESTAMPTZ NULL,
      payload_json JSONB NOT NULL,
      updated_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_machine_summaries_reported_at
      ON machine_summaries (reported_at_utc DESC);
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_machine_summaries_trust_calibration
      ON machine_summaries (trust_tier, calibration_stage);
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_machine_summaries_capture_context
      ON machine_summaries (capture_context);
  `);

  await activePool.query(`
    CREATE TABLE IF NOT EXISTS machine_action_events (
      id BIGSERIAL PRIMARY KEY,
      machine_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      intervention_id TEXT NOT NULL,
      action TEXT NOT NULL,
      action_category TEXT NOT NULL,
      decision_state TEXT NOT NULL,
      execution_state TEXT NOT NULL,
      verified_state TEXT NOT NULL,
      timestamp_utc TIMESTAMPTZ NOT NULL,
      applied_at_utc TIMESTAMPTZ NULL,
      error_code TEXT NULL,
      policy_id TEXT NOT NULL,
      what_changed TEXT NULL,
      how_to_undo TEXT NULL,
      payload_json JSONB NOT NULL,
      created_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (machine_id, intervention_id, timestamp_utc, action, execution_state, verified_state)
    );
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_machine_action_events_machine_ts
      ON machine_action_events (machine_id, timestamp_utc DESC);
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_machine_action_events_execution
      ON machine_action_events (execution_state, verified_state, timestamp_utc DESC);
  `);
}

export async function resetFleetPersistenceForTests(): Promise<void> {
  schemaReadyPromise = null;

  if (pool) {
    await pool.end().catch(() => undefined);
    pool = null;
  }
}
