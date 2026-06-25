import { getAccountProfile } from '../store/accountStore.js';
import { getUserHistory } from '../store/userHistoryStore.js';
import { getAccountsWithQualifyingStatsForDate } from '../store/dailyStatsStore.js';
import { wasDigestSentForAccount, appendDigestLogEntry } from '../store/digestLogStore.js';
import { recomputeUserHistory } from './historyService.js';
import { buildDigestEmail, type DailyDigestPayload } from './digestEmailBuilder.js';
import { sendEmail } from './emailService.js';
import type { DailyStats } from '../store/dailyStatsStore.js';

// Dubai is UTC+4 — same timezone used by DailyDigestReporter.cs
const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;

function todayInDubai(): string {
  const dubaiNow = new Date(Date.now() + DUBAI_OFFSET_MS);
  return dubaiNow.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function mostDistractedHourLabel(hour: number | null): string {
  if (hour === null || hour < 0) return 'n/a';
  return `${String(hour).padStart(2, '0')}:00-${String(hour).padStart(2, '0')}:59`;
}

function statsToDigestPayload(stats: DailyStats): DailyDigestPayload {
  return {
    accountId: stats.accountId,
    deviceId: '',
    machineId: 'server-cron',
    dateLocal: stats.dateLocal,
    timezoneOffsetMinutes: 240, // Dubai UTC+4
    reportedAtUtc: new Date().toISOString(),
    trackedSeconds: stats.trackedSeconds,
    focusSeconds: stats.focusSeconds,
    // daily_stats stores focusScore as 0–100; DailyDigestPayload expects 0–1
    focusQualityScore: stats.focusScore / 100,
    distractionSeconds: stats.distractionSeconds,
    awaySeconds: stats.awaySeconds,
    contextExcursionSeconds: 0,
    longestFocusStreakSeconds: stats.longestStreakSeconds,
    fragmentationEpisodeCount: stats.distractionCount,
    socialMediaLoopCount: stats.socialMediaLoops,
    gamingEpisodeCount: 0,
    socialMediaSeconds: stats.socialMediaSeconds,
    gamingLauncherSeconds: 0,
    gamingActiveSeconds: 0,
    passiveConsumptionSeconds: 0,
    commMonitoringReturnCount: 0,
    socialMediaReturnCount: stats.socialMediaLoops,
    overloadEpisodeCount: stats.overloadEvents,
    breaksTakenCount: stats.breaksTaken,
    breaksSuggestedCount: stats.breaksSuggested,
    mostDistractedHourLabel: mostDistractedHourLabel(stats.mostDistractedHour),
    developmentSeconds: 0,
    productivitySeconds: 0,
    communicationSeconds: 0,
    entertainmentSeconds: 0,
    firstFocusBlockUtc: stats.firstFocusUtc ?? null,
    peakPressureUtc: stats.peakPressureUtc ?? null,
    avgDistractionEpisodeDurationSeconds: stats.avgDistractionDurationSeconds,
    contextSwitchCount: stats.contextSwitchCount,
    preLongestDistractionFocusSeconds: 0,
    // daily_stats has no gaming or context-excursion columns. Declaring them
    // missing makes the email render "no data" instead of a confident 0
    // (the zeros above are kept only to satisfy the payload shape).
    missingFields: ['gaming', 'contextSwitches'],
    // Real per-app foreground time captured during the day — same "where your time
    // went" section the live digest shows, now available in the server-fallback path.
    ...(stats.topApps && stats.topApps.length > 0 ? { topApps: stats.topApps } : {}),
    isServerFallback: true,
  };
}

/**
 * Server-side fallback: send daily digest emails to accounts that have qualifying
 * stats for today but haven't received an email yet (machine was off at 19:30 UTC).
 * Called at 20:30 UTC daily from main.ts.
 */
export async function runDailyDigestCron(): Promise<void> {
  const dateLocal = todayInDubai();
  const baseUrl = process.env.PORTA_CONTROL_PLANE_URL?.replace(/\/$/, '')
    ?? 'https://porta-control-plane.onrender.com';
  const launchUrl = baseUrl + '/launch';

  console.log(`[digest-cron] Running for date=${dateLocal}`);

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  let qualifyingStats: DailyStats[];
  try {
    qualifyingStats = await getAccountsWithQualifyingStatsForDate(dateLocal);
  } catch (err) {
    console.error('[digest-cron] Failed to load qualifying stats:', err instanceof Error ? err.message : String(err));
    return;
  }

  console.log(`[digest-cron] Found ${qualifyingStats.length} account(s) with qualifying stats for ${dateLocal}`);

  for (const stats of qualifyingStats) {
    const { accountId } = stats;
    try {
      // Skip if agent already sent the email (computer was on at 19:30 UTC)
      const alreadySent = await wasDigestSentForAccount(accountId, dateLocal);
      if (alreadySent) {
        skipped++;
        continue;
      }

      const [profile, history] = await Promise.all([
        getAccountProfile(accountId),
        getUserHistory(accountId),
      ]);

      if (!profile?.primaryEmail) {
        skipped++;
        continue;
      }

      const payload = statsToDigestPayload(stats);
      const firstName = profile.firstName ?? null;
      const { subject, html } = await buildDigestEmail(payload, launchUrl, history, firstName);
      const emailSent = await sendEmail({ to: profile.primaryEmail, subject, html });

      await appendDigestLogEntry({
        machineId: 'server-cron',
        accountId,
        dateLocal,
        trackedSeconds: stats.trackedSeconds,
        fired: emailSent,
        failureReason: emailSent ? null : 'send_failed',
        sentAtUtc: new Date().toISOString(),
      });

      if (emailSent) {
        sent++;
        console.log(`[digest-cron] Sent fallback digest for account ${accountId} to ${profile.primaryEmail}`);
        // Recompute history now that we've confirmed today's stats are written
        await recomputeUserHistory(accountId);
      } else {
        failed++;
        console.warn(`[digest-cron] Failed to send digest for account ${accountId}`);
      }
    } catch (err) {
      failed++;
      console.error(`[digest-cron] Error processing account ${accountId}:`, err instanceof Error ? err.message : String(err));
    }
  }

  console.log(`[digest-cron] Done — sent=${sent} skipped=${skipped} failed=${failed}`);
}
