import { getFleetPersistenceMode, getFleetPool, ensureFleetPersistenceReady } from '../store/fleetPersistence.js';
import { getDailyStatsForAccount } from '../store/dailyStatsStore.js';
import { upsertUserHistory, defaultHistory, type UserHistory } from '../store/userHistoryStore.js';

/**
 * Recomputes user_history from daily_stats for the given account.
 * Called after every daily_stats write. Never throws — catches all errors.
 */
export async function recomputeUserHistory(accountId: string): Promise<void> {
  try {
    await recomputeUserHistoryUnsafe(accountId);
  } catch (err) {
    console.error(`[historyService] Failed to recompute user_history for ${accountId}:`, err);
  }
}

async function recomputeUserHistoryUnsafe(accountId: string): Promise<void> {
  const h = defaultHistory(accountId);
  const usePostgres = getFleetPersistenceMode() === 'postgres';

  if (usePostgres) {
    await ensureFleetPersistenceReady();
  }
  const pool = usePostgres ? getFleetPool() : null;

  // ── days_of_data ─────────────────────────────────────────────────────────
  if (pool) {
    const r = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM daily_stats WHERE account_id = $1;`,
      [accountId]
    );
    h.daysOfData = parseInt(r.rows[0]?.count ?? '0', 10);
  } else {
    const rows = await getDailyStatsForAccount(accountId, 9999);
    h.daysOfData = rows.length;
  }

  if (h.daysOfData === 0) {
    await upsertUserHistory(h);
    return;
  }

  // ── consecutive_streak ───────────────────────────────────────────────────
  // Count backward from today: days in a row with tracked_seconds >= 3600
  const today = new Date();
  const todayStr = formatDate(today);

  if (pool) {
    const streakRows = await pool.query<{ date_local: string }>(
      `
        SELECT date_local FROM daily_stats
        WHERE account_id = $1 AND tracked_seconds >= 3600
        ORDER BY date_local DESC;
      `,
      [accountId]
    );
    h.consecutiveStreak = computeConsecutiveStreak(streakRows.rows.map(r => r.date_local), todayStr);
  } else {
    const rows = await getDailyStatsForAccount(accountId, 9999);
    const qualDates = rows.filter(r => r.trackedSeconds >= 3600).map(r => r.dateLocal);
    h.consecutiveStreak = computeConsecutiveStreak(qualDates, todayStr);
  }

  // ── focus_trend (requires 7+ days) ───────────────────────────────────────
  if (pool) {
    const d7Ago = formatDate(addDays(today, -7));
    const d14Ago = formatDate(addDays(today, -14));

    const trendRows = await pool.query<{ last7avg: number | null; prior7avg: number | null }>(
      `
        SELECT
          AVG(CASE WHEN date_local >= $2 THEN focus_pct END) as last7avg,
          AVG(CASE WHEN date_local < $2 AND date_local >= $3 THEN focus_pct END) as prior7avg
        FROM daily_stats
        WHERE account_id = $1 AND date_local >= $3;
      `,
      [accountId, d7Ago, d14Ago]
    );

    const last7 = trendRows.rows[0]?.last7avg ?? null;
    const prior7 = trendRows.rows[0]?.prior7avg ?? null;
    h.focusTrend = computeFocusTrend(last7, prior7, h.daysOfData);
  } else {
    const rows = await getDailyStatsForAccount(accountId, 14);
    const last7 = rows.slice(0, 7).map(r => r.focusPct);
    const prior7 = rows.slice(7, 14).map(r => r.focusPct);
    const last7avg = last7.length > 0 ? avg(last7) : null;
    const prior7avg = prior7.length > 0 ? avg(prior7) : null;
    h.focusTrend = computeFocusTrend(last7avg, prior7avg, h.daysOfData);
  }

  // ── 30-day rolling averages ───────────────────────────────────────────────
  const d30Ago = formatDate(addDays(today, -30));

  if (pool) {
    const avgRows = await pool.query<{
      avg_focus_pct: number; avg_focus_score: number; avg_tracked_min: number;
      avg_streak_min: number; avg_pressure_pct: number; avg_distraction_count: number;
      avg_distraction_dur_min: number; avg_context_switches: number;
      avg_breaks_taken: number; avg_breaks_suggested: number;
      avg_focus_episode_dur_min: number;
    }>(
      `
        SELECT
          AVG(focus_pct)                           as avg_focus_pct,
          AVG(focus_score)                         as avg_focus_score,
          AVG(tracked_seconds / 60.0)              as avg_tracked_min,
          AVG(longest_streak_seconds / 60.0)       as avg_streak_min,
          AVG(pressure_avg_pct)                    as avg_pressure_pct,
          AVG(distraction_count)                   as avg_distraction_count,
          AVG(avg_distraction_duration_seconds / 60.0) as avg_distraction_dur_min,
          AVG(context_switch_count)                as avg_context_switches,
          AVG(breaks_taken)                        as avg_breaks_taken,
          AVG(breaks_suggested)                    as avg_breaks_suggested,
          AVG(focus_seconds / GREATEST(1.0, distraction_count + 1) / 60.0) as avg_focus_episode_dur_min
        FROM daily_stats
        WHERE account_id = $1 AND date_local >= $2;
      `,
      [accountId, d30Ago]
    );

    const ar = avgRows.rows[0];
    if (ar) {
      h.avgFocusPct = round2(ar.avg_focus_pct ?? 0);
      h.avgFocusScore = round2(ar.avg_focus_score ?? 0);
      h.avgTrackedMin = round2(ar.avg_tracked_min ?? 0);
      h.avgStreakMin = round2(ar.avg_streak_min ?? 0);
      h.avgPressurePct = round2(ar.avg_pressure_pct ?? 0);
      h.avgDistractionCount = round2(ar.avg_distraction_count ?? 0);
      h.avgDistractionDurMin = round2(ar.avg_distraction_dur_min ?? 0);
      h.avgContextSwitches = round2(ar.avg_context_switches ?? 0);
      h.avgBreaksTaken = round2(ar.avg_breaks_taken ?? 0);
      h.avgBreaksSuggested = round2(ar.avg_breaks_suggested ?? 0);
      h.avgFocusEpisodeDurMin = round2(ar.avg_focus_episode_dur_min ?? 0);
    }
  } else {
    const rows = await getDailyStatsForAccount(accountId, 30);
    if (rows.length > 0) {
      h.avgFocusPct = round2(avg(rows.map(r => r.focusPct)));
      h.avgFocusScore = round2(avg(rows.map(r => r.focusScore)));
      h.avgTrackedMin = round2(avg(rows.map(r => r.trackedSeconds / 60)));
      h.avgStreakMin = round2(avg(rows.map(r => r.longestStreakSeconds / 60)));
      h.avgPressurePct = round2(avg(rows.map(r => r.pressureAvgPct)));
      h.avgDistractionCount = round2(avg(rows.map(r => r.distractionCount)));
      h.avgDistractionDurMin = round2(avg(rows.map(r => r.avgDistractionDurationSeconds / 60)));
      h.avgContextSwitches = round2(avg(rows.map(r => r.contextSwitchCount)));
      h.avgBreaksTaken = round2(avg(rows.map(r => r.breaksTaken)));
      h.avgBreaksSuggested = round2(avg(rows.map(r => r.breaksSuggested)));
      h.avgFocusEpisodeDurMin = round2(avg(rows.map(r => r.focusSeconds / Math.max(1, r.distractionCount + 1) / 60)));
    }
  }

  // ── personal bests (all-time) ─────────────────────────────────────────────
  if (pool) {
    const bestRows = await pool.query<{
      best_focus_pct: number; best_focus_pct_date: string;
      best_focus_score: number; best_focus_score_date: string;
      best_streak_min: number; best_streak_date: string;
      best_tracked_min: number;
    }>(
      `
        SELECT
          MAX(focus_pct)                                                  as best_focus_pct,
          (SELECT date_local FROM daily_stats WHERE account_id = $1 ORDER BY focus_pct DESC LIMIT 1) as best_focus_pct_date,
          MAX(focus_score)                                                as best_focus_score,
          (SELECT date_local FROM daily_stats WHERE account_id = $1 ORDER BY focus_score DESC LIMIT 1) as best_focus_score_date,
          MAX(longest_streak_seconds / 60.0)                             as best_streak_min,
          (SELECT date_local FROM daily_stats WHERE account_id = $1 ORDER BY longest_streak_seconds DESC LIMIT 1) as best_streak_date,
          MAX(tracked_seconds / 60.0)                                    as best_tracked_min
        FROM daily_stats WHERE account_id = $1;
      `,
      [accountId]
    );

    const br = bestRows.rows[0];
    if (br) {
      h.bestFocusPct = round2(br.best_focus_pct ?? 0);
      h.bestFocusScore = round2(br.best_focus_score ?? 0);
      h.bestStreakMin = round2(br.best_streak_min ?? 0);
      h.bestTrackedMin = round2(br.best_tracked_min ?? 0);
      h.bestStreakDate = br.best_streak_date ?? null;
      h.bestFocusScoreDate = br.best_focus_score_date ?? null;
    }
  } else {
    const rows = await getDailyStatsForAccount(accountId, 9999);
    if (rows.length > 0) {
      const bestFocusPctRow = rows.reduce((a, b) => a.focusPct > b.focusPct ? a : b);
      const bestFocusScoreRow = rows.reduce((a, b) => a.focusScore > b.focusScore ? a : b);
      const bestStreakRow = rows.reduce((a, b) => a.longestStreakSeconds > b.longestStreakSeconds ? a : b);
      const bestTrackedRow = rows.reduce((a, b) => a.trackedSeconds > b.trackedSeconds ? a : b);
      h.bestFocusPct = round2(bestFocusPctRow.focusPct);
      h.bestFocusScore = round2(bestFocusScoreRow.focusScore);
      h.bestStreakMin = round2(bestStreakRow.longestStreakSeconds / 60);
      h.bestTrackedMin = round2(bestTrackedRow.trackedSeconds / 60);
      h.bestStreakDate = bestStreakRow.dateLocal;
      h.bestFocusScoreDate = bestFocusScoreRow.dateLocal;
    }
  }

  // ── per day-of-week averages (minimum 2 occurrences) ─────────────────────
  if (pool) {
    const dowRows = await pool.query<{
      day_of_week: number; cnt: string;
      avg_focus_pct: number; avg_tracked_min: number; avg_focus_score: number;
    }>(
      `
        SELECT
          day_of_week,
          COUNT(*) as cnt,
          AVG(focus_pct)               as avg_focus_pct,
          AVG(tracked_seconds / 60.0)  as avg_tracked_min,
          AVG(focus_score)             as avg_focus_score
        FROM daily_stats
        WHERE account_id = $1
        GROUP BY day_of_week
        HAVING COUNT(*) >= 2;
      `,
      [accountId]
    );

    for (const r of dowRows.rows) {
      const d = String(r.day_of_week);
      h.dowAvgFocusPct[d] = round2(r.avg_focus_pct);
      h.dowAvgTrackedMin[d] = round2(r.avg_tracked_min);
      h.dowAvgFocusScore[d] = round2(r.avg_focus_score);
    }
  } else {
    const rows = await getDailyStatsForAccount(accountId, 9999);
    const byDow = new Map<number, { focusPct: number[]; trackedMin: number[]; focusScore: number[] }>();
    for (const r of rows) {
      if (!byDow.has(r.dayOfWeek)) byDow.set(r.dayOfWeek, { focusPct: [], trackedMin: [], focusScore: [] });
      const b = byDow.get(r.dayOfWeek)!;
      b.focusPct.push(r.focusPct);
      b.trackedMin.push(r.trackedSeconds / 60);
      b.focusScore.push(r.focusScore);
    }
    for (const [dow, b] of byDow.entries()) {
      if (b.focusPct.length < 2) continue;
      const d = String(dow);
      h.dowAvgFocusPct[d] = round2(avg(b.focusPct));
      h.dowAvgTrackedMin[d] = round2(avg(b.trackedMin));
      h.dowAvgFocusScore[d] = round2(avg(b.focusScore));
    }
  }

  // ── weak_hour + strong_window (requires 14+ days) ─────────────────────────
  if (h.daysOfData >= 14) {
    if (pool) {
      // weak_hour: mode of most_distracted_hour
      const weakRows = await pool.query<{ most_distracted_hour: number; cnt: string }>(
        `
          SELECT most_distracted_hour, COUNT(*) as cnt
          FROM daily_stats
          WHERE account_id = $1 AND most_distracted_hour IS NOT NULL
          GROUP BY most_distracted_hour
          ORDER BY cnt DESC, most_distracted_hour ASC
          LIMIT 1;
        `,
        [accountId]
      );
      if (weakRows.rows.length > 0) {
        h.weakHour = weakRows.rows[0]!.most_distracted_hour;
      }

      // strong_window: hour with highest avg focus_score from first_focus_utc
      const strongRows = await pool.query<{ hour: number; avg_score: number }>(
        `
          SELECT
            EXTRACT(HOUR FROM first_focus_utc::timestamptz AT TIME ZONE 'UTC')::INTEGER as hour,
            AVG(focus_score) as avg_score
          FROM daily_stats
          WHERE account_id = $1 AND first_focus_utc IS NOT NULL
          GROUP BY hour
          ORDER BY avg_score DESC
          LIMIT 1;
        `,
        [accountId]
      );
      if (strongRows.rows.length > 0) {
        const sh = strongRows.rows[0]!.hour;
        h.strongWindowStart = sh;
        h.strongWindowEnd = sh + 2;
      }
    } else {
      const rows = await getDailyStatsForAccount(accountId, 9999);

      // weak_hour: mode
      const hourCounts = new Map<number, number>();
      for (const r of rows) {
        if (r.mostDistractedHour == null) continue;
        hourCounts.set(r.mostDistractedHour, (hourCounts.get(r.mostDistractedHour) ?? 0) + 1);
      }
      if (hourCounts.size > 0) {
        const weakEntry = [...hourCounts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
        if (weakEntry !== undefined) h.weakHour = weakEntry[0];
      }

      // strong_window: hour with best avg focus_score from first_focus_utc
      const hourScores = new Map<number, number[]>();
      for (const r of rows) {
        if (!r.firstFocusUtc) continue;
        const hr = new Date(r.firstFocusUtc).getUTCHours();
        if (!hourScores.has(hr)) hourScores.set(hr, []);
        hourScores.get(hr)!.push(r.focusScore);
      }
      if (hourScores.size > 0) {
        const strongEntry = [...hourScores.entries()]
          .sort((a, b) => avg(b[1]) - avg(a[1]))[0];
        if (strongEntry !== undefined) {
          h.strongWindowStart = strongEntry[0];
          h.strongWindowEnd = strongEntry[0] + 2;
        }
      }
    }
  }

  await upsertUserHistory(h);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(d: Date): string {
  return d.toISOString().substring(0, 10);
}

function addDays(d: Date, days: number): Date {
  const result = new Date(d);
  result.setDate(result.getDate() + days);
  return result;
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function computeFocusTrend(
  last7avg: number | null,
  prior7avg: number | null,
  daysOfData: number
): 'improving' | 'stable' | 'declining' {
  if (daysOfData < 7 || last7avg == null || prior7avg == null) return 'stable';
  const diff = last7avg - prior7avg;
  if (diff >= 5) return 'improving';
  if (diff <= -5) return 'declining';
  return 'stable';
}

function computeConsecutiveStreak(sortedDatesDesc: string[], todayStr: string): number {
  let streak  = 0;
  let expected = todayStr;
  for (const date of sortedDatesDesc) {
    if (date === expected) {
      streak++;
      expected = formatDate(addDays(new Date(expected), -1));
    } else if (date < expected) {
      // Gap found — stop
      break;
    }
    // date > expected means there's a future date, skip
  }
  return streak;
}
 0;
  let expected = todayStr;
  for (const date of sortedDatesDesc) {
    if (date === expected) {
      streak++;
      expected = formatDate(addDays(new Date(expected), -1));
    } else if (date < expected) {
      // Gap found — stop
      break;
    }
    // date > expected means there's a future date, skip
  }
  return streak;
}
