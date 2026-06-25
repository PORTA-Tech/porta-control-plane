import { ensureFleetPersistenceReady, getFleetPersistenceMode, getFleetPool } from './fleetPersistence.js';

/** One app/site's coarse foreground time for the day. Label is a coarse token only. */
export interface FocusAppUsage {
  label: string;
  seconds: number;
}

export interface DailyStats {
  accountId: string;
  dateLocal: string;           // "YYYY-MM-DD"
  dayOfWeek: number;           // 0=Sun … 6=Sat
  trackedSeconds: number;
  focusSeconds: number;
  focusPct: number;
  focusScore: number;
  longestStreakSeconds: number;
  distractionSeconds: number;
  distractionCount: number;
  avgDistractionDurationSeconds: number;
  contextSwitchCount: number;
  overloadEvents: number;
  breaksTaken: number;
  breaksSuggested: number;
  socialMediaLoops: number;
  socialMediaSeconds: number;
  awaySeconds: number;
  pressureAvgPct: number;
  firstFocusUtc: string | null;
  peakPressureUtc: string | null;
  mostDistractedHour: number | null;
  topApps: FocusAppUsage[];
}

// In-memory fallback when Postgres is not available
const memoryStore = new Map<string, DailyStats>();

function memoryKey(accountId: string, dateLocal: string): string {
  return `${accountId}::${dateLocal}`;
}

export async function upsertDailyStats(stats: DailyStats): Promise<void> {
  if (getFleetPersistenceMode() === 'memory') {
    memoryStore.set(memoryKey(stats.accountId, stats.dateLocal), stats);
    return;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    memoryStore.set(memoryKey(stats.accountId, stats.dateLocal), stats);
    return;
  }

  await pool.query(
    `
      INSERT INTO daily_stats (
        account_id, date_local, day_of_week, tracked_seconds, focus_seconds,
        focus_pct, focus_score, longest_streak_seconds, distraction_seconds,
        distraction_count, avg_distraction_duration_seconds, context_switch_count,
        overload_events, breaks_taken, breaks_suggested, social_media_loops,
        social_media_seconds, away_seconds, pressure_avg_pct, first_focus_utc,
        peak_pressure_utc, most_distracted_hour, top_apps
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
      )
      ON CONFLICT (account_id, date_local) DO UPDATE SET
        day_of_week = EXCLUDED.day_of_week,
        tracked_seconds = EXCLUDED.tracked_seconds,
        focus_seconds = EXCLUDED.focus_seconds,
        focus_pct = EXCLUDED.focus_pct,
        focus_score = EXCLUDED.focus_score,
        longest_streak_seconds = EXCLUDED.longest_streak_seconds,
        distraction_seconds = EXCLUDED.distraction_seconds,
        distraction_count = EXCLUDED.distraction_count,
        avg_distraction_duration_seconds = EXCLUDED.avg_distraction_duration_seconds,
        context_switch_count = EXCLUDED.context_switch_count,
        overload_events = EXCLUDED.overload_events,
        breaks_taken = EXCLUDED.breaks_taken,
        breaks_suggested = EXCLUDED.breaks_suggested,
        social_media_loops = EXCLUDED.social_media_loops,
        social_media_seconds = EXCLUDED.social_media_seconds,
        away_seconds = EXCLUDED.away_seconds,
        pressure_avg_pct = EXCLUDED.pressure_avg_pct,
        first_focus_utc = EXCLUDED.first_focus_utc,
        peak_pressure_utc = EXCLUDED.peak_pressure_utc,
        most_distracted_hour = EXCLUDED.most_distracted_hour,
        top_apps = EXCLUDED.top_apps;
    `,
    [
      stats.accountId, stats.dateLocal, stats.dayOfWeek, stats.trackedSeconds,
      stats.focusSeconds, stats.focusPct, stats.focusScore, stats.longestStreakSeconds,
      stats.distractionSeconds, stats.distractionCount, stats.avgDistractionDurationSeconds,
      stats.contextSwitchCount, stats.overloadEvents, stats.breaksTaken, stats.breaksSuggested,
      stats.socialMediaLoops, stats.socialMediaSeconds, stats.awaySeconds, stats.pressureAvgPct,
      stats.firstFocusUtc, stats.peakPressureUtc, stats.mostDistractedHour ?? null,
      JSON.stringify(stats.topApps ?? [])
    ]
  );
}

/** Normalizes a stored JSONB top_apps value (or memory-store value) into a clean array. */
function normalizeTopApps(value: unknown): FocusAppUsage[] {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: FocusAppUsage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const label = (item as { label?: unknown }).label;
    const seconds = (item as { seconds?: unknown }).seconds;
    if (typeof label === 'string' && label.trim() !== '' && typeof seconds === 'number' && seconds > 0) {
      out.push({ label: label.trim().slice(0, 40), seconds });
    }
  }
  return out;
}

export async function getDailyStatsForAccount(accountId: string, limitDays = 90): Promise<DailyStats[]> {
  if (getFleetPersistenceMode() === 'memory') {
    return Array.from(memoryStore.values())
      .filter(s => s.accountId === accountId)
      .sort((a, b) => b.dateLocal.localeCompare(a.dateLocal))
      .slice(0, limitDays);
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return Array.from(memoryStore.values())
      .filter(s => s.accountId === accountId)
      .sort((a, b) => b.dateLocal.localeCompare(a.dateLocal))
      .slice(0, limitDays);
  }

  const result = await pool.query<{
    account_id: string; date_local: string; day_of_week: number;
    tracked_seconds: number; focus_seconds: number; focus_pct: number;
    focus_score: number; longest_streak_seconds: number; distraction_seconds: number;
    distraction_count: number; avg_distraction_duration_seconds: number;
    context_switch_count: number; overload_events: number; breaks_taken: number;
    breaks_suggested: number; social_media_loops: number; social_media_seconds: number;
    away_seconds: number; pressure_avg_pct: number; first_focus_utc: string | null;
    peak_pressure_utc: string | null; most_distracted_hour: number | null;
    top_apps: unknown;
  }>(
    `
      SELECT * FROM daily_stats
      WHERE account_id = $1
      ORDER BY date_local DESC
      LIMIT $2;
    `,
    [accountId, limitDays]
  );

  return result.rows.map(r => ({
    accountId: r.account_id,
    dateLocal: r.date_local,
    dayOfWeek: r.day_of_week,
    trackedSeconds: r.tracked_seconds,
    focusSeconds: r.focus_seconds,
    focusPct: r.focus_pct,
    focusScore: r.focus_score,
    longestStreakSeconds: r.longest_streak_seconds,
    distractionSeconds: r.distraction_seconds,
    distractionCount: r.distraction_count,
    avgDistractionDurationSeconds: r.avg_distraction_duration_seconds,
    contextSwitchCount: r.context_switch_count,
    overloadEvents: r.overload_events,
    breaksTaken: r.breaks_taken,
    breaksSuggested: r.breaks_suggested,
    socialMediaLoops: r.social_media_loops,
    socialMediaSeconds: r.social_media_seconds,
    awaySeconds: r.away_seconds,
    pressureAvgPct: r.pressure_avg_pct,
    firstFocusUtc: r.first_focus_utc,
    peakPressureUtc: r.peak_pressure_utc,
    mostDistractedHour: r.most_distracted_hour,
    topApps: normalizeTopApps(r.top_apps)
  }));
}

/**
 * Returns all accounts that have qualifying stats (>= 3600 tracked seconds) for the given date.
 * Used by the server-side digest cron to find who needs a fallback email.
 */
export async function getAccountsWithQualifyingStatsForDate(dateLocal: string): Promise<DailyStats[]> {
  if (getFleetPersistenceMode() === 'memory') {
    return Array.from(memoryStore.values()).filter(
      s => s.dateLocal === dateLocal && s.trackedSeconds >= 3600
    );
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return Array.from(memoryStore.values()).filter(
      s => s.dateLocal === dateLocal && s.trackedSeconds >= 3600
    );
  }

  const result = await pool.query<{
    account_id: string; date_local: string; day_of_week: number;
    tracked_seconds: number; focus_seconds: number; focus_pct: number;
    focus_score: number; longest_streak_seconds: number; distraction_seconds: number;
    distraction_count: number; avg_distraction_duration_seconds: number;
    context_switch_count: number; overload_events: number; breaks_taken: number;
    breaks_suggested: number; social_media_loops: number; social_media_seconds: number;
    away_seconds: number; pressure_avg_pct: number; first_focus_utc: string | null;
    peak_pressure_utc: string | null; most_distracted_hour: number | null;
    top_apps: unknown;
  }>(
    'SELECT * FROM daily_stats WHERE date_local = $1 AND tracked_seconds >= 3600',
    [dateLocal]
  );

  return result.rows.map(r => ({
    accountId: r.account_id,
    dateLocal: r.date_local,
    dayOfWeek: r.day_of_week,
    trackedSeconds: r.tracked_seconds,
    focusSeconds: r.focus_seconds,
    focusPct: r.focus_pct,
    focusScore: r.focus_score,
    longestStreakSeconds: r.longest_streak_seconds,
    distractionSeconds: r.distraction_seconds,
    distractionCount: r.distraction_count,
    avgDistractionDurationSeconds: r.avg_distraction_duration_seconds,
    contextSwitchCount: r.context_switch_count,
    overloadEvents: r.overload_events,
    breaksTaken: r.breaks_taken,
    breaksSuggested: r.breaks_suggested,
    socialMediaLoops: r.social_media_loops,
    socialMediaSeconds: r.social_media_seconds,
    awaySeconds: r.away_seconds,
    pressureAvgPct: r.pressure_avg_pct,
    firstFocusUtc: r.first_focus_utc,
    peakPressureUtc: r.peak_pressure_utc,
    mostDistractedHour: r.most_distracted_hour,
    topApps: normalizeTopApps(r.top_apps)
  }));
}
