import { Pool } from 'pg';

export type FleetPersistenceMode = 'postgres' | 'memory';

let pool: Pool | null = null;
let schemaReadyPromise: Promise<void> | null = null;
let activeDatabaseUrl: string | null = null;

function parseBoolean(raw: string | undefined): boolean | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }

  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  return null;
}

function readFleetDatabaseUrl(): string {
  return process.env.PORTA_CONTROL_PLANE_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || '';
}

function isProductionLikeEnvironment(): boolean {
  const nodeEnv = (process.env.NODE_ENV ?? '').trim().toLowerCase();
  return nodeEnv === 'production' || parseBoolean(process.env.RENDER) === true;
}

function isSslRequired(connectionString: string): boolean {
  return /render\.com/i.test(connectionString) || /sslmode=require/i.test(connectionString);
}

export function getFleetPersistenceMode(): FleetPersistenceMode {
  return readFleetDatabaseUrl().length > 0 ? 'postgres' : 'memory';
}

export function getFleetDatabaseUrl(): string | null {
  const databaseUrl = readFleetDatabaseUrl();
  return databaseUrl.length > 0 ? databaseUrl : null;
}

export function shouldRequirePersistentFleetState(): boolean {
  const explicitRequirement = parseBoolean(process.env.PORTA_CONTROL_PLANE_REQUIRE_PERSISTENT_FLEET);
  if (explicitRequirement !== null) {
    return explicitRequirement;
  }

  if (parseBoolean(process.env.PORTA_CONTROL_PLANE_ALLOW_IN_MEMORY_FLEET) === true) {
    return false;
  }

  return isProductionLikeEnvironment();
}

export function assertFleetPersistenceConfigured(): void {
  if (getFleetPersistenceMode() !== 'memory') {
    return;
  }

  if (!shouldRequirePersistentFleetState()) {
    return;
  }

  throw new Error(
    'Fleet persistence is running in memory. Configure PORTA_CONTROL_PLANE_DATABASE_URL or DATABASE_URL before starting this control-plane node.'
  );
}

export function getFleetPool(): Pool | null {
  const databaseUrl = getFleetDatabaseUrl();
  if (!databaseUrl) {
    return null;
  }

  if (pool && activeDatabaseUrl === databaseUrl) {
    return pool;
  }

  if (pool) {
    void pool.end().catch(() => undefined);
    pool = null;
  }

  activeDatabaseUrl = databaseUrl;
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
    CREATE TABLE IF NOT EXISTS accounts (
      account_id UUID PRIMARY KEY,
      primary_email TEXT NOT NULL,
      display_name TEXT NOT NULL,
      email_verified BOOLEAN NOT NULL,
      status TEXT NOT NULL,
      auth_provider TEXT NULL,
      last_login_at TIMESTAMPTZ NULL,
      payload_json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
  `);

  await activePool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_primary_email
      ON accounts (primary_email);
  `);

  await activePool.query(`
    CREATE TABLE IF NOT EXISTS organizations (
      org_id UUID PRIMARY KEY,
      org_name TEXT NOT NULL,
      org_slug TEXT NULL,
      plan_tier TEXT NOT NULL,
      billing_account_id TEXT NULL,
      payload_json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
  `);

  await activePool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_org_slug
      ON organizations (org_slug)
      WHERE org_slug IS NOT NULL;
  `);

  await activePool.query(`
    CREATE TABLE IF NOT EXISTS memberships (
      membership_id UUID PRIMARY KEY,
      account_id UUID NOT NULL REFERENCES accounts (account_id) ON DELETE CASCADE,
      org_id UUID NOT NULL REFERENCES organizations (org_id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      invited_at TIMESTAMPTZ NULL,
      joined_at TIMESTAMPTZ NULL,
      invited_by_account_id UUID NULL REFERENCES accounts (account_id) ON DELETE SET NULL,
      payload_json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (account_id, org_id)
    );
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_memberships_account_id
      ON memberships (account_id);
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_memberships_org_id
      ON memberships (org_id);
  `);

  await activePool.query(`
    CREATE TABLE IF NOT EXISTS devices (
      device_id UUID PRIMARY KEY,
      org_id UUID NULL REFERENCES organizations (org_id) ON DELETE SET NULL,
      machine_name TEXT NOT NULL,
      device_display_name TEXT NOT NULL,
      platform TEXT NOT NULL,
      agent_version TEXT NOT NULL,
      status TEXT NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL,
      current_account_id UUID NULL REFERENCES accounts (account_id) ON DELETE SET NULL,
      revoked_at TIMESTAMPTZ NULL,
      payload_json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_devices_org_id
      ON devices (org_id);
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_devices_current_account_id
      ON devices (current_account_id);
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_devices_last_seen_at
      ON devices (last_seen_at DESC);
  `);

  // Stage 3 — per-device credentials. Only the sha256 hash is ever stored; the plaintext
  // secret is returned once at issuance and never again. Nullable by design: every device
  // registered before this column existed has no credential, and the device-auth middleware
  // must keep working for them while PORTA_DEVICE_AUTH_MODE is still 'log'.
  await activePool.query(`
    ALTER TABLE devices
      ADD COLUMN IF NOT EXISTS device_secret_hash TEXT;
    ALTER TABLE devices
      ADD COLUMN IF NOT EXISTS device_secret_created_at_utc TIMESTAMPTZ;
  `);

  // Every credential issuance, durably. Deliberately its own table rather than the .data
  // audit files: those are ephemeral on Render and reset on deploy, and the whole point of
  // this log is to make an unexpected claim visible afterwards. Never deleted on unlink or
  // re-issue -- the history is the evidence.
  await activePool.query(`
    CREATE TABLE IF NOT EXISTS device_credential_issuances (
      issuance_id UUID PRIMARY KEY,
      device_id UUID NOT NULL,
      account_id UUID NULL,
      issued_at_utc TIMESTAMPTZ NOT NULL,
      source TEXT NOT NULL,
      source_ip TEXT NULL,
      user_agent TEXT NULL,
      replaced_existing BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_device_credential_issuances_device_id
      ON device_credential_issuances (device_id, issued_at_utc DESC);
  `);

  await activePool.query(`
    CREATE TABLE IF NOT EXISTS consent_records (
      consent_id UUID PRIMARY KEY,
      scope TEXT NOT NULL,
      account_id UUID NULL REFERENCES accounts (account_id) ON DELETE SET NULL,
      device_id UUID NULL REFERENCES devices (device_id) ON DELETE SET NULL,
      org_id UUID NULL REFERENCES organizations (org_id) ON DELETE SET NULL,
      consent_version TEXT NOT NULL,
      consent_state TEXT NOT NULL,
      telemetry_level TEXT NULL,
      consented_at TIMESTAMPTZ NOT NULL,
      payload_json JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_consent_records_account_id
      ON consent_records (account_id);
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_consent_records_device_id
      ON consent_records (device_id);
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_consent_records_org_id
      ON consent_records (org_id);
  `);

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

  await activePool.query(`
    CREATE TABLE IF NOT EXISTS auth_users (
      account_id UUID PRIMARY KEY,
      user_id TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_algo TEXT NOT NULL,
      role TEXT NOT NULL,
      source TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_url TEXT NULL,
      auth_provider TEXT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      last_login_at TIMESTAMPTZ NULL
    );
  `);

  await activePool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_user_id_lower
      ON auth_users (LOWER(user_id));
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_auth_users_source_status
      ON auth_users (source, status);
  `);

  await activePool.query(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      session_id UUID PRIMARY KEY,
      token_hash TEXT NOT NULL,
      account_id UUID NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_url TEXT NULL,
      auth_provider TEXT NULL,
      issued_at_utc TIMESTAMPTZ NOT NULL,
      expires_at_utc TIMESTAMPTZ NOT NULL,
      reauth_expires_at_utc TIMESTAMPTZ NOT NULL,
      revoked_at_utc TIMESTAMPTZ NULL,
      created_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await activePool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_sessions_token_hash
      ON auth_sessions (token_hash);
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_account_id
      ON auth_sessions (account_id, expires_at_utc DESC);
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id
      ON auth_sessions (LOWER(user_id), expires_at_utc DESC);
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_active_expiry
      ON auth_sessions (expires_at_utc ASC, reauth_expires_at_utc ASC)
      WHERE revoked_at_utc IS NULL;
  `);

  // 4.6a — refresh tokens share this table rather than getting their own. session_type is
  // the discriminator: only 'access' rows are accepted as bearer tokens, only 'refresh'
  // rows are redeemable at POST /auth/refresh. Every row that predates this column is an
  // access session, which is what the DEFAULT encodes.
  //
  // refresh_family_id ties an access token to the refresh token that minted it, and ties
  // each rotation to the one before. It is what makes reuse of a rotated-away refresh
  // token revoke the whole chain instead of just the presented row.
  await activePool.query(`
    ALTER TABLE auth_sessions
      ADD COLUMN IF NOT EXISTS session_type TEXT NOT NULL DEFAULT 'access';
    ALTER TABLE auth_sessions
      ADD COLUMN IF NOT EXISTS refresh_family_id UUID;
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_refresh_family
      ON auth_sessions (refresh_family_id)
      WHERE refresh_family_id IS NOT NULL;
  `);

  await activePool.query(`
    CREATE TABLE IF NOT EXISTS growth_events (
      event_id UUID PRIMARY KEY,
      event_key TEXT NOT NULL,
      event_type TEXT NOT NULL,
      account_id UUID NULL,
      user_id TEXT NULL,
      device_id UUID NULL,
      org_id UUID NULL,
      machine_id TEXT NULL,
      occurred_at_utc TIMESTAMPTZ NOT NULL,
      source TEXT NOT NULL,
      payload_json JSONB NOT NULL,
      created_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await activePool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_growth_events_event_key
      ON growth_events (event_key);
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_growth_events_account_ts
      ON growth_events (account_id, occurred_at_utc DESC);
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_growth_events_user_ts
      ON growth_events (LOWER(user_id), occurred_at_utc DESC)
      WHERE user_id IS NOT NULL;
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_growth_events_type_ts
      ON growth_events (event_type, occurred_at_utc DESC);
  `);

  await activePool.query(`
    CREATE TABLE IF NOT EXISTS account_active_day (
      account_id UUID NOT NULL,
      activity_date DATE NOT NULL,
      first_activity_at_utc TIMESTAMPTZ NOT NULL,
      last_activity_at_utc TIMESTAMPTZ NOT NULL,
      last_machine_id TEXT NULL,
      source_count INTEGER NOT NULL CHECK (source_count >= 0),
      updated_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (account_id, activity_date)
    );
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_account_active_day_date
      ON account_active_day (activity_date DESC);
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_account_active_day_last_activity
      ON account_active_day (last_activity_at_utc DESC);
  `);

  await activePool.query(`
    CREATE TABLE IF NOT EXISTS digest_log (
      machine_id      TEXT        NOT NULL,
      account_id      TEXT,
      date_local      TEXT        NOT NULL,
      tracked_seconds INTEGER     NOT NULL DEFAULT 0,
      fired           BOOLEAN     NOT NULL DEFAULT FALSE,
      failure_reason  TEXT,
      sent_at_utc     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (machine_id, date_local)
    );
  `);

  await activePool.query(`
    CREATE TABLE IF NOT EXISTS daily_stats (
      account_id                        TEXT        NOT NULL,
      date_local                        TEXT        NOT NULL,
      day_of_week                       INTEGER     NOT NULL,
      tracked_seconds                   REAL        NOT NULL DEFAULT 0,
      focus_seconds                     REAL        NOT NULL DEFAULT 0,
      focus_pct                         REAL        NOT NULL DEFAULT 0,
      focus_score                       REAL        NOT NULL DEFAULT 0,
      longest_streak_seconds            REAL        NOT NULL DEFAULT 0,
      distraction_seconds               REAL        NOT NULL DEFAULT 0,
      distraction_count                 INTEGER     NOT NULL DEFAULT 0,
      avg_distraction_duration_seconds  REAL        NOT NULL DEFAULT 0,
      context_switch_count              INTEGER     NOT NULL DEFAULT 0,
      overload_events                   INTEGER     NOT NULL DEFAULT 0,
      breaks_taken                      INTEGER     NOT NULL DEFAULT 0,
      breaks_suggested                  INTEGER     NOT NULL DEFAULT 0,
      social_media_loops                INTEGER     NOT NULL DEFAULT 0,
      social_media_seconds              REAL        NOT NULL DEFAULT 0,
      away_seconds                      REAL        NOT NULL DEFAULT 0,
      pressure_avg_pct                  REAL        NOT NULL DEFAULT 0,
      first_focus_utc                   TEXT,
      peak_pressure_utc                 TEXT,
      most_distracted_hour              INTEGER,
      created_at_utc                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (account_id, date_local)
    );
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_daily_stats_account_date
      ON daily_stats (account_id, date_local DESC);
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_daily_stats_account_dow
      ON daily_stats (account_id, day_of_week);
  `);


  // Index for server-side digest cron: scan all accounts with stats for a given date
  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_daily_stats_date
      ON daily_stats (date_local);
  `);

  // Index for digest deduplication: check if account already received email today
  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_digest_log_account_date
      ON digest_log (account_id, date_local);
  `);

  // Safe migration: coarse per-app foreground time for the day (JSON array of
  // {label, seconds}). Powers the console per-app view and the server-fallback digest.
  await activePool.query(`
    ALTER TABLE daily_stats
      ADD COLUMN IF NOT EXISTS top_apps JSONB;
  `);

  // Digest C1: the day's stated goal + the midday yes/partly/not_yet answer, uploaded by the
  // agent's 2-hourly stats report. daily_goals is an AGENT-LOCAL table, so this is the only way
  // the server-cron fallback digest (built from daily_stats) can lead with the user's goal.
  // Nullable by design — a user who set no goal must render as "no goal", never as an empty one.
  await activePool.query(`
    ALTER TABLE daily_stats
      ADD COLUMN IF NOT EXISTS goal TEXT;
    ALTER TABLE daily_stats
      ADD COLUMN IF NOT EXISTS midday_answer TEXT;
  `);

  // Phase 1b — Step 4c: privacy-safe ground-truth label engagement (counts only, no content).
  await activePool.query(`
    ALTER TABLE daily_stats
      ADD COLUMN IF NOT EXISTS labels_today INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE daily_stats
      ADD COLUMN IF NOT EXISTS labels_this_week INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE daily_stats
      ADD COLUMN IF NOT EXISTS labels_by_target JSONB;
  `);

  // Anti-spam / #2: prompt response rate — shown vs answered — so the console shows real engagement.
  await activePool.query(`
    ALTER TABLE daily_stats
      ADD COLUMN IF NOT EXISTS prompts_shown_today INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE daily_stats
      ADD COLUMN IF NOT EXISTS prompts_answered_today INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE daily_stats
      ADD COLUMN IF NOT EXISTS prompts_shown_week INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE daily_stats
      ADD COLUMN IF NOT EXISTS prompts_answered_week INTEGER NOT NULL DEFAULT 0;
  `);

  await activePool.query(`
    CREATE TABLE IF NOT EXISTS user_history (
      account_id              TEXT PRIMARY KEY,
      days_of_data            INTEGER     NOT NULL DEFAULT 0,
      consecutive_streak      INTEGER     NOT NULL DEFAULT 0,
      focus_trend             TEXT        NOT NULL DEFAULT 'stable',
      avg_focus_pct           REAL        NOT NULL DEFAULT 0,
      avg_focus_score         REAL        NOT NULL DEFAULT 0,
      avg_tracked_min         REAL        NOT NULL DEFAULT 0,
      avg_streak_min          REAL        NOT NULL DEFAULT 0,
      avg_pressure_pct        REAL        NOT NULL DEFAULT 0,
      avg_distraction_count   REAL        NOT NULL DEFAULT 0,
      avg_distraction_dur_min REAL        NOT NULL DEFAULT 0,
      avg_context_switches    REAL        NOT NULL DEFAULT 0,
      avg_breaks_taken        REAL        NOT NULL DEFAULT 0,
      avg_breaks_suggested    REAL        NOT NULL DEFAULT 0,
      best_focus_pct          REAL        NOT NULL DEFAULT 0,
      best_focus_score        REAL        NOT NULL DEFAULT 0,
      best_streak_min         REAL        NOT NULL DEFAULT 0,
      best_tracked_min        REAL        NOT NULL DEFAULT 0,
      best_streak_date        TEXT,
      best_focus_score_date   TEXT,
      dow_avg_focus_pct       TEXT        NOT NULL DEFAULT '{}',
      dow_avg_tracked_min     TEXT        NOT NULL DEFAULT '{}',
      dow_avg_focus_score     TEXT        NOT NULL DEFAULT '{}',
      weak_hour               INTEGER,
      strong_window_start          INTEGER,
      strong_window_end            INTEGER,
      avg_focus_episode_dur_min    REAL        NOT NULL DEFAULT 0,
      updated_at_utc               TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Safe migration: add column to existing deployments that predate this field.
  await activePool.query(`
    ALTER TABLE user_history
      ADD COLUMN IF NOT EXISTS avg_focus_episode_dur_min REAL NOT NULL DEFAULT 0;
  `);

  await activePool.query(`
    CREATE TABLE IF NOT EXISTS message_rotation (
      account_id    TEXT        NOT NULL,
      message_key   TEXT        NOT NULL,
      shown_at_utc  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (account_id, message_key)
    );
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_message_rotation_account
      ON message_rotation (account_id, shown_at_utc DESC);
  `);

  await activePool.query(`
    CREATE TABLE IF NOT EXISTS machine_uptime_samples (
      machine_id             TEXT        NOT NULL,
      sampled_at_utc         TIMESTAMPTZ NOT NULL,
      agent_running          BOOLEAN     NOT NULL DEFAULT FALSE,
      user_session_connected BOOLEAN     NOT NULL DEFAULT FALSE,
      activity_detected      BOOLEAN     NOT NULL DEFAULT FALSE,
      PRIMARY KEY (machine_id, sampled_at_utc)
    );
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_uptime_machine_time
      ON machine_uptime_samples (machine_id, sampled_at_utc DESC);
  `);

  // 2d: coarse app-category labels resolved for tokens the agent could not classify locally.
  // token = coarse identity ([a-z0-9-]: a browser site token like "notion" or an exe base name
  // like "obsidian"); NEVER a raw URL/title. category = one of the 8 AppCategory names (or
  // 'Unknown' while pending). source precedence at read time: override > curated > llm > pending.
  await activePool.query(`
    CREATE TABLE IF NOT EXISTS app_category_labels (
      token       TEXT        PRIMARY KEY,
      category    TEXT        NOT NULL,
      source      TEXT        NOT NULL,
      model_ver   TEXT        NULL,
      created_at  TIMESTAMPTZ NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL
    );
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_app_category_labels_source
      ON app_category_labels (source);
  `);

  // Step 10 phase D (2026-08-14) — client reports, sent from here rather than from the machine
  // because the Resend key must never reach a user's device (spec §6a).
  //
  // report_id is the PRIMARY KEY and that is load-bearing, not incidental: it is the idempotency
  // key, and it is what makes "the same report never sends twice" a property of the database
  // instead of something a caller has to remember. A duplicate INSERT is a retry, never a new send,
  // and a second copy in a client's inbox cannot be recalled.
  //
  // recipient_email belongs to somebody who never installed Ari and agreed to nothing (§12.0), so
  // deletion is a real DELETE rather than a flag, and it is per report, on request.
  await activePool.query(`
    CREATE TABLE IF NOT EXISTS sent_reports (
      report_id         TEXT        PRIMARY KEY,
      account_id        TEXT        NOT NULL,
      device_id         TEXT        NOT NULL,
      machine_id        TEXT        NOT NULL,
      project_name      TEXT        NOT NULL,
      range_start_local TEXT        NOT NULL,
      range_end_local   TEXT        NOT NULL,
      recipient_email   TEXT        NOT NULL,
      recipient_name    TEXT        NOT NULL DEFAULT '',
      from_name         TEXT        NOT NULL DEFAULT '',
      reply_to          TEXT        NOT NULL DEFAULT '',
      total_hours       DOUBLE PRECISION NOT NULL DEFAULT 0,
      days_worked       INTEGER     NOT NULL DEFAULT 0,
      tasks_completed   INTEGER     NOT NULL DEFAULT 0,
      tasks_total       INTEGER     NOT NULL DEFAULT 0,
      lines_json        JSONB       NOT NULL,
      daily_json        JSONB       NOT NULL,
      requested_at_utc  TIMESTAMPTZ NOT NULL,
      sent_at_utc       TIMESTAMPTZ NULL,
      send_state        TEXT        NOT NULL DEFAULT 'pending',
      send_error        TEXT        NOT NULL DEFAULT ''
    );
  `);

  // Phase 2b (2026-08-17) — the permanent link and the frozen page.
  //
  // page_html is the RENDERED page, not the data behind it. What the client opens has to be what
  // was sent, forever, so re-rendering a stored object with a later version of the renderer is
  // exactly the silent rewrite this must not do. Regenerating a report writes a NEW row with a NEW
  // token instead.
  //
  // page_token is a long random value, never the report id and never sequential: the page has no
  // login, because a client will not make an account, so the token IS the access control.
  await activePool.query(`
    ALTER TABLE sent_reports ADD COLUMN IF NOT EXISTS page_token TEXT;
    ALTER TABLE sent_reports ADD COLUMN IF NOT EXISTS page_html  TEXT NOT NULL DEFAULT '';
    ALTER TABLE sent_reports ADD COLUMN IF NOT EXISTS summary    TEXT NOT NULL DEFAULT '';
  `);

  await activePool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sent_reports_page_token
      ON sent_reports (page_token) WHERE page_token IS NOT NULL;
  `);

  await activePool.query(`
    CREATE INDEX IF NOT EXISTS idx_sent_reports_account
      ON sent_reports (account_id, requested_at_utc DESC);
  `);
}

export async function resetFleetPersistenceForTests(): Promise<void> {
  schemaReadyPromise = null;
  activeDatabaseUrl = null;

  if (pool) {
    await pool.end().catch(() => undefined);
    pool = null;
  }
}
