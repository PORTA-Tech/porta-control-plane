import { ensureFleetPersistenceReady, getFleetPersistenceMode, getFleetPool } from './fleetPersistence.js';

export interface UserHistory {
  accountId: string;
  daysOfData: number;
  consecutiveStreak: number;
  focusTrend: 'improving' | 'stable' | 'declining';
  avgFocusPct: number;
  avgFocusScore: number;
  avgTrackedMin: number;
  avgStreakMin: number;
  avgPressurePct: number;
  avgDistractionCount: number;
  avgDistractionDurMin: number;
  avgContextSwitches: number;
  avgBreaksTaken: number;
  avgBreaksSuggested: number;
  bestFocusPct: number;
  bestFocusScore: number;
  bestStreakMin: number;
  bestTrackedMin: number;
  bestStreakDate: string | null;
  bestFocusScoreDate: string | null;
  dowAvgFocusPct: Record<string, number>;
  dowAvgTrackedMin: Record<string, number>;
  dowAvgFocusScore: Record<string, number>;
  weakHour: number | null;
  strongWindowStart: number | null;
  strongWindowEnd: number | null;
  updatedAtUtc: string;
}

const memoryStore = new Map<string, UserHistory>();

const defaultHistory = (accountId: string): UserHistory => ({
  accountId,
  daysOfData: 0,
  consecutiveStreak: 0,
  focusTrend: 'stable',
  avgFocusPct: 0,
  avgFocusScore: 0,
  avgTrackedMin: 0,
  avgStreakMin: 0,
  avgPressurePct: 0,
  avgDistractionCount: 0,
  avgDistractionDurMin: 0,
  avgContextSwitches: 0,
  avgBreaksTaken: 0,
  avgBreaksSuggested: 0,
  bestFocusPct: 0,
  bestFocusScore: 0,
  bestStreakMin: 0,
  bestTrackedMin: 0,
  bestStreakDate: null,
  bestFocusScoreDate: null,
  dowAvgFocusPct: {},
  dowAvgTrackedMin: {},
  dowAvgFocusScore: {},
  weakHour: null,
  strongWindowStart: null,
  strongWindowEnd: null,
  updatedAtUtc: new Date().toISOString()
});

export async function upsertUserHistory(h: UserHistory): Promise<void> {
  if (getFleetPersistenceMode() === 'memory') {
    memoryStore.set(h.accountId, h);
    return;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    memoryStore.set(h.accountId, h);
    return;
  }

  await pool.query(
    `
      INSERT INTO user_history (
        account_id, days_of_data, consecutive_streak, focus_trend,
        avg_focus_pct, avg_focus_score, avg_tracked_min, avg_streak_min,
        avg_pressure_pct, avg_distraction_count, avg_distraction_dur_min,
        avg_context_switches, avg_breaks_taken, avg_breaks_suggested,
        best_focus_pct, best_focus_score, best_streak_min, best_tracked_min,
        best_streak_date, best_focus_score_date,
        dow_avg_focus_pct, dow_avg_tracked_min, dow_avg_focus_score,
        weak_hour, strong_window_start, strong_window_end, updated_at_utc
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, NOW()
      )
      ON CONFLICT (account_id) DO UPDATE SET
        days_of_data = EXCLUDED.days_of_data,
        consecutive_streak = EXCLUDED.consecutive_streak,
        focus_trend = EXCLUDED.focus_trend,
        avg_focus_pct = EXCLUDED.avg_focus_pct,
        avg_focus_score = EXCLUDED.avg_focus_score,
        avg_tracked_min = EXCLUDED.avg_tracked_min,
        avg_streak_min = EXCLUDED.avg_streak_min,
        avg_pressure_pct = EXCLUDED.avg_pressure_pct,
        avg_distraction_count = EXCLUDED.avg_distraction_count,
        avg_distraction_dur_min = EXCLUDED.avg_distraction_dur_min,
        avg_context_switches = EXCLUDED.avg_context_switches,
        avg_breaks_taken = EXCLUDED.avg_breaks_taken,
        avg_breaks_suggested = EXCLUDED.avg_breaks_suggested,
        best_focus_pct = EXCLUDED.best_focus_pct,
        best_focus_score = EXCLUDED.best_focus_score,
        best_streak_min = EXCLUDED.best_streak_min,
        best_tracked_min = EXCLUDED.best_tracked_min,
        best_streak_date = EXCLUDED.best_streak_date,
        best_focus_score_date = EXCLUDED.best_focus_score_date,
        dow_avg_focus_pct = EXCLUDED.dow_avg_focus_pct,
        dow_avg_tracked_min = EXCLUDED.dow_avg_tracked_min,
        dow_avg_focus_score = EXCLUDED.dow_avg_focus_score,
        weak_hour = EXCLUDED.weak_hour,
        strong_window_start = EXCLUDED.strong_window_start,
        strong_window_end = EXCLUDED.strong_window_end,
        updated_at_utc = NOW();
    `,
    [
      h.accountId, h.daysOfData, h.consecutiveStreak, h.focusTrend,
      h.avgFocusPct, h.avgFocusScore, h.avgTrackedMin, h.avgStreakMin,
      h.avgPressurePct, h.avgDistractionCount, h.avgDistractionDurMin,
      h.avgContextSwitches, h.avgBreaksTaken, h.avgBreaksSuggested,
      h.bestFocusPct, h.bestFocusScore, h.bestStreakMin, h.bestTrackedMin,
      h.bestStreakDate, h.bestFocusScoreDate,
      JSON.stringify(h.dowAvgFocusPct), JSON.stringify(h.dowAvgTrackedMin), JSON.stringify(h.dowAvgFocusScore),
      h.weakHour ?? null, h.strongWindowStart ?? null, h.strongWindowEnd ?? null
    ]
  );
}

export async function getUserHistory(accountId: string): Promise<UserHistory | null> {
  if (getFleetPersistenceMode() === 'memory') {
    return memoryStore.get(accountId) ?? null;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return memoryStore.get(accountId) ?? null;
  }

  const result = await pool.query<Record<string, unknown>>(
    `SELECT * FROM user_history WHERE account_id = $1 LIMIT 1;`,
    [accountId]
  );

  const r = result.rows[0];
  if (!r) return null;

  return {
    accountId: r.account_id as string,
    daysOfData: Number(r.days_of_data),
    consecutiveStreak: Number(r.consecutive_streak),
    focusTrend: (r.focus_trend as string) as 'improving' | 'stable' | 'declining',
    avgFocusPct: Number(r.avg_focus_pct),
    avgFocusScore: Number(r.avg_focus_score),
    avgTrackedMin: Number(r.avg_tracked_min),
    avgStreakMin: Number(r.avg_streak_min),
    avgPressurePct: Number(r.avg_pressure_pct),
    avgDistractionCount: Number(r.avg_distraction_count),
    avgDistractionDurMin: Number(r.avg_distraction_dur_min),
    avgContextSwitches: Number(r.avg_context_switches),
    avgBreaksTaken: Number(r.avg_breaks_taken),
    avgBreaksSuggested: Number(r.avg_breaks_suggested),
    bestFocusPct: Number(r.best_focus_pct),
    bestFocusScore: Number(r.best_focus_score),
    bestStreakMin: Number(r.best_streak_min),
    bestTrackedMin: Number(r.best_tracked_min),
    bestStreakDate: r.best_streak_date as string | null,
    bestFocusScoreDate: r.best_focus_score_date as string | null,
    dowAvgFocusPct: safeParseJson(r.dow_avg_focus_pct as string),
    dowAvgTrackedMin: safeParseJson(r.dow_avg_tracked_min as string),
    dowAvgFocusScore: safeParseJson(r.dow_avg_focus_score as string),
    weakHour: r.weak_hour != null ? Number(r.weak_hour) : null,
    strongWindowStart: r.strong_window_start != null ? Number(r.strong_window_start) : null,
    strongWindowEnd: r.strong_window_end != null ? Number(r.strong_window_end) : null,
    updatedAtUtc: r.updated_at_utc as string
  };
}

function safeParseJson(val: string | null | undefined): Record<string, number> {
  if (!val) return {};
  try {
    const parsed = JSON.parse(val);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export { defaultHistory };
