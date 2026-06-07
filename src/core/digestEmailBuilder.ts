import type { UserHistory } from '../store/userHistoryStore.js';
import { wasMessageShownRecently, recordMessageShown } from '../store/messageRotationStore.js';
import { getDailyStatsForAccount } from '../store/dailyStatsStore.js';

export interface DailyDigestPayload {
  accountId?: string | null;
  deviceId: string;
  machineId: string;
  dateLocal: string;
  timezoneOffsetMinutes: number;
  reportedAtUtc: string;
  trackedSeconds: number;
  focusSeconds: number;
  focusQualityScore: number;
  distractionSeconds: number;
  awaySeconds: number;
  contextExcursionSeconds: number;
  longestFocusStreakSeconds: number;
  fragmentationEpisodeCount: number;
  socialMediaLoopCount: number;
  gamingEpisodeCount: number;
  socialMediaSeconds: number;
  gamingLauncherSeconds: number;
  gamingActiveSeconds: number;
  passiveConsumptionSeconds: number;
  commMonitoringReturnCount: number;
  socialMediaReturnCount: number;
  overloadEpisodeCount: number;
  breaksTakenCount: number;
  breaksSuggestedCount: number;
  mostDistractedHourLabel: string;
  developmentSeconds: number;
  productivitySeconds: number;
  communicationSeconds: number;
  entertainmentSeconds: number;
  // Phase 1A — new timeline fields for messaging system
  firstFocusBlockUtc?: string | null;
  peakPressureUtc?: string | null;
  avgDistractionEpisodeDurationSeconds?: number;
  contextSwitchCount?: number;
  preLongestDistractionFocusSeconds?: number;
}

// ── Formatting helpers ──────────────────────────────────────────────

function fmtMinutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

function pct(num: number, denom: number): string {
  if (denom <= 0) return '0%';
  return `${Math.round((num / denom) * 100)}%`;
}

function focusGrade(score: number): { label: string; color: string } {
  if (score >= 0.8) return { label: 'Excellent', color: '#22c55e' };
  if (score >= 0.65) return { label: 'Good', color: '#84cc16' };
  if (score >= 0.45) return { label: 'Fair', color: '#f59e0b' };
  return { label: 'Low', color: '#ef4444' };
}

function fmt12h(hour: number): string {
  const suffix = hour >= 12 ? 'pm' : 'am';
  const h12 = hour % 12 || 12;
  return `${h12}${suffix}`;
}

function formatPastDate(d: string | null | undefined): string {
  if (!d) return 'a previous session';
  try {
    const dt = new Date(d + 'T00:00:00');
    return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  } catch {
    return d;
  }
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

// ── Template rotation helper ──────────────────────────────────────────────────

async function selectTemplate(
  condition: string,
  templates: string[],
  accountId: string
): Promise<{ text: string; key: string }> {
  for (let i = 0; i < templates.length; i++) {
    const key = `digest:${condition}:t${i}`;
    const used = await wasMessageShownRecently(accountId, key);
    if (!used) {
      await recordMessageShown(accountId, key);
      return { text: templates[i]!, key };
    }
  }
  // All templates used recently — cycle back to first
  const key = `digest:${condition}:t0`;
  await recordMessageShown(accountId, key);
  return { text: templates[0]!, key };
}

// ── Condition evaluation ──────────────────────────────────────────────────────

type ConditionResult = { score: number; message: string } | null;

// Condition A — Streak / Trend (score: 90)
// Minimum 3 days. Fires when streak >= 3 OR focusTrend === 'improving'.
async function conditionA(
  p: DailyDigestPayload,
  h: UserHistory,
  accountId: string,
  name: string,
  todayFocusPct: number
): Promise<ConditionResult> {
  if (h.daysOfData < 3) return null;
  const hasStreak = h.consecutiveStreak >= 3;
  const hasTrend = h.focusTrend === 'improving';
  if (!hasStreak && !hasTrend) return null;

  const templates: string[] = [];

  if (hasStreak && hasTrend) {
    templates.push(
      `${h.consecutiveStreak} days tracked in a row.\nYour focus average this week is ${todayFocusPct}% — your best stretch this month.`
    );
  }
  if (hasStreak) {
    templates.push(
      `${name ? name + ', ' : ''}${h.consecutiveStreak} days in a row with focus above your average.\nSomething is working — keep the chain intact.`
    );
  }
  if (hasTrend) {
    templates.push(
      `Focus has been climbing over the past several days.\nYour recent average is ${todayFocusPct}% — above where you were last week.`
    );
  }

  const { text } = await selectTemplate('A', templates, accountId);
  return { score: 90, message: text };
}

// Condition B — Personal Record (score: 85)
// Minimum 5 days. Fires when today beats best focus score, streak, or focus pct.
async function conditionB(
  p: DailyDigestPayload,
  h: UserHistory,
  accountId: string,
  name: string,
  todayFocusPct: number,
  todayFocusScore: number
): Promise<ConditionResult> {
  if (h.daysOfData < 5) return null;

  const isBestScore = todayFocusScore > h.bestFocusScore;
  const todayStreakMin = p.longestFocusStreakSeconds / 60;
  const isBestStreak = todayStreakMin > h.bestStreakMin;
  const isBestFocusPct = todayFocusPct > h.bestFocusPct;

  if (!isBestScore && !isBestStreak && !isBestFocusPct) return null;

  const templates: string[] = [];

  if (isBestScore) {
    templates.push(
      `${name ? name + ', focus' : 'Focus'} score of ${todayFocusScore} today — your best recorded.\nPrevious best was ${Math.round(h.bestFocusScore)} on ${formatPastDate(h.bestFocusScoreDate)}.`
    );
  }
  if (isBestStreak) {
    templates.push(
      `${Math.round(todayStreakMin)}min uninterrupted focus — your longest recorded.\nAri has been watching for ${h.daysOfData} days. This is the best run yet.`
    );
  }
  if (isBestFocusPct) {
    templates.push(
      `${todayFocusPct}% focus rate today — personal record.\nYour previous best was ${Math.round(h.bestFocusPct)}%.`
    );
  }

  const { text } = await selectTemplate('B', templates, accountId);
  return { score: 85, message: text };
}

// Condition C — Day-of-Week Comparison (score: 80)
// Minimum 14 days (proxy for 2+ occurrences of same weekday in dowAvg map).
// Fires when |todayFocusPct - dowAvg| >= 15.
async function conditionC(
  p: DailyDigestPayload,
  h: UserHistory,
  accountId: string,
  name: string,
  todayFocusPct: number
): Promise<ConditionResult> {
  if (h.daysOfData < 14) return null;

  const dateObj = new Date(p.dateLocal + 'T00:00:00');
  const dow = dateObj.getDay();
  const dowKey = String(dow);
  const dowAvg = h.dowAvgFocusPct[dowKey];
  const dowAvgTracked = h.dowAvgTrackedMin[dowKey];

  if (dowAvg == null) return null;

  const diff = todayFocusPct - dowAvg;
  if (Math.abs(diff) < 15) return null;

  const dayName = DAY_NAMES[dow] ?? 'today';
  const todayTrackedMin = Math.round(p.trackedSeconds / 60);

  const templates: string[] = [];

  if (diff >= 15) {
    templates.push(
      `${name ? name + ', your' : 'Your'} ${todayFocusPct}% focus rate today is your best ${dayName} this month.\n${dayName}s average ${Math.round(dowAvg)}% for you.`
    );
  } else {
    templates.push(
      `Below your ${dayName} average by ${Math.abs(Math.round(diff))}%.\nYou usually hit ${Math.round(dowAvg)}% on ${dayName}s — today was ${todayFocusPct}%.`
    );
    if (dowAvgTracked != null) {
      templates.push(
        `Quiet ${dayName}. ${todayTrackedMin}min tracked versus your usual ${Math.round(dowAvgTracked)}min.\nNot every ${dayName} needs to be a push.`
      );
    }
  }

  const { text } = await selectTemplate('C', templates, accountId);
  return { score: 80, message: text };
}

// Condition D — Pressure Pattern (score: 75)
// Minimum 7 days. Fires when overload episodes are elevated OR peak pressure matched weak hour.
async function conditionD(
  p: DailyDigestPayload,
  h: UserHistory,
  accountId: string,
  name: string
): Promise<ConditionResult> {
  if (h.daysOfData < 7) return null;

  const contextSwitchCount = p.contextSwitchCount ?? 0;
  const overloadEpisodes = p.overloadEpisodeCount;
  const isHighPressure = overloadEpisodes >= 2;

  const peakHour = p.peakPressureUtc ? new Date(p.peakPressureUtc).getUTCHours() : null;
  const matchesWeakHour = h.weakHour != null && peakHour !== null && peakHour === h.weakHour;

  if (!isHighPressure && !matchesWeakHour) return null;

  const templates: string[] = [];

  if (matchesWeakHour && h.weakHour != null) {
    templates.push(
      `Pressure peaked at ${h.weakHour}:00 — your historically difficult window.\nThat pattern has shown up before.`
    );
  }
  if (isHighPressure && contextSwitchCount > 0) {
    templates.push(
      `${overloadEpisodes} overload events today — above your normal.\n${contextSwitchCount} context switches contributed. Wind down properly tonight.`
    );
  }
  if (isHighPressure) {
    templates.push(
      `${name ? name + ', high' : 'High'} pressure day. ${overloadEpisodes} overload episodes above your baseline.\nYour recovery quality tonight will shape tomorrow's start.`
    );
  }

  if (templates.length === 0) return null;

  const { text } = await selectTemplate('D', templates, accountId);
  return { score: 75, message: text };
}

// Condition E — Focus Quality vs Quantity Split (score: 70)
// No minimum data. Fires on time-in-seat-not-present or short-but-deep patterns.
async function conditionE(
  p: DailyDigestPayload,
  accountId: string,
  todayFocusPct: number,
  todayFocusScore: number
): Promise<ConditionResult> {
  const timeInSeatNotPresent = todayFocusPct >= 50 && todayFocusScore < 45;
  const shortButDeep = todayFocusPct < 30 && todayFocusScore >= 70;

  if (!timeInSeatNotPresent && !shortButDeep) return null;

  const todayTrackedMin = Math.round(p.trackedSeconds / 60);
  const todayFocusMin = Math.round(p.focusSeconds / 60);
  const qualityGrade = focusGrade(p.focusQualityScore).label;

  const templates: string[] = [];

  if (timeInSeatNotPresent) {
    templates.push(
      `${todayFocusPct}% focus time today, but quality score only ${todayFocusScore}.\nTime in seat, but not fully there. Common after high-pressure or fragmented days.`
    );
  }
  if (shortButDeep) {
    templates.push(
      `Short day — only ${todayTrackedMin}min tracked — but focus quality was ${qualityGrade}.\n${todayFocusMin}min of actual deep work. That counts.`
    );
    templates.push(
      `Only ${todayTrackedMin}min tracked, but your focus score was ${todayFocusScore}.\nWhen you were working, you were really working.`
    );
  }

  const { text } = await selectTemplate('E', templates, accountId);
  return { score: 70, message: text };
}

// Condition F — Distraction Pattern (score: 65)
// Minimum 5 days. Fires when distraction count, duration, or social loops are elevated.
async function conditionF(
  p: DailyDigestPayload,
  h: UserHistory,
  accountId: string
): Promise<ConditionResult> {
  if (h.daysOfData < 5) return null;

  const avgDistrDurMin = (p.avgDistractionEpisodeDurationSeconds ?? 0) / 60;
  const distractionCount = p.fragmentationEpisodeCount;
  const aboveCount = h.avgDistractionCount > 0 && distractionCount > h.avgDistractionCount * 1.3;
  const aboveDur = h.avgDistractionDurMin > 0 && avgDistrDurMin > h.avgDistractionDurMin * 1.3;
  const belowDur = h.avgDistractionDurMin > 0 && avgDistrDurMin < h.avgDistractionDurMin && avgDistrDurMin > 0;
  const socialLoops = p.socialMediaLoopCount >= 5;

  if (!aboveCount && !aboveDur && !socialLoops) return null;

  const avgDistrMin = Math.round(avgDistrDurMin);
  const totalLostMin = Math.round(p.distractionSeconds / 60);

  const templates: string[] = [];

  if (aboveCount && !belowDur) {
    templates.push(
      `${distractionCount} distraction episodes today — above your usual ${Math.round(h.avgDistractionCount)}.\nAverage drift was ${avgDistrMin}min. Total focus lost: ${totalLostMin}min.`
    );
  }
  if (socialLoops) {
    templates.push(
      `You returned to social media ${p.socialMediaLoopCount} times today.\nYour typical is lower. That's a pattern worth watching.`
    );
  }
  // Fast recovery variant: count high but duration below average
  if (aboveCount && belowDur) {
    templates.push(
      `${distractionCount} distraction episodes today, but you recovered from each in under ${avgDistrMin}min — faster than your average of ${Math.round(h.avgDistractionDurMin)}min.`
    );
  }

  if (templates.length === 0) return null;

  const { text } = await selectTemplate('F', templates, accountId);
  return { score: 65, message: text };
}

// Condition G — Break Compliance (score: 60)
// No minimum data. Fires on zero breaks or perfect compliance.
async function conditionG(
  p: DailyDigestPayload,
  accountId: string
): Promise<ConditionResult> {
  const trackedMinutes = p.trackedSeconds / 60;
  const noBreaksTaken = p.breaksTakenCount === 0 && trackedMinutes >= 90 && p.breaksSuggestedCount >= 1;
  const allBreaksTaken = p.breaksTakenCount === p.breaksSuggestedCount && p.breaksSuggestedCount >= 2;

  if (!noBreaksTaken && !allBreaksTaken) return null;

  const todayTrackedH = (trackedMinutes / 60).toFixed(1);
  const peakHour = p.peakPressureUtc ? new Date(p.peakPressureUtc).getUTCHours() : null;
  const missed = p.breaksSuggestedCount - p.breaksTakenCount;

  const templates: string[] = [];

  if (noBreaksTaken) {
    templates.push(
      `No breaks across ${todayTrackedH}h of work.\nAri suggested ${p.breaksSuggestedCount}. Skipping recovery raises your overload risk over time.`
    );
  }
  if (allBreaksTaken) {
    templates.push(
      `You took every break Ari suggested today — ${p.breaksTakenCount} of ${p.breaksSuggestedCount}.\nThat kind of compliance is rare. Your afternoon focus reflected it.`
    );
  }
  if (!allBreaksTaken && p.breaksTakenCount > 0 && missed > 0 && peakHour !== null) {
    templates.push(
      `${p.breaksTakenCount} of ${p.breaksSuggestedCount} breaks taken.\nThe ${missed} you skipped coincided with your pressure peak at ${peakHour}:00.`
    );
  }

  if (templates.length === 0) return null;

  const { text } = await selectTemplate('G', templates, accountId);
  return { score: 60, message: text };
}

// Condition H — Recovery After Below-Average Day (score: 55)
// Minimum 2 days. Fires when today is above average and yesterday was below.
async function conditionH(
  p: DailyDigestPayload,
  h: UserHistory,
  accountId: string,
  todayFocusPct: number,
  todayFocusScore: number
): Promise<ConditionResult> {
  if (h.daysOfData < 2) return null;
  if (todayFocusScore <= h.avgFocusScore) return null;

  // Most recent row in daily_stats (today hasn't been written yet — it's written after this runs)
  const recentRows = await getDailyStatsForAccount(accountId, 1);
  const yesterdayRow = recentRows[0];
  if (!yesterdayRow) return null;
  if (yesterdayRow.dateLocal >= p.dateLocal) return null; // safety check
  if (yesterdayRow.focusScore >= h.avgFocusScore) return null;

  const templates: string[] = [
    `Back above your average after yesterday.\n${todayFocusScore} today — your mean is ${Math.round(h.avgFocusScore)}. Good recovery.`,
    `${todayFocusPct}% focus today, up from yesterday.\nAbove your average for the first time this week.`
  ];

  const { text } = await selectTemplate('H', templates, accountId);
  return { score: 55, message: text };
}

// Condition I — Strong Window Recognition (score: 50)
// Minimum 14 days. Fires when first focus block falls within the user's strongest hour window.
async function conditionI(
  p: DailyDigestPayload,
  h: UserHistory,
  accountId: string
): Promise<ConditionResult> {
  if (h.daysOfData < 14) return null;
  if (h.strongWindowStart == null) return null;

  const firstFocusHour = p.firstFocusBlockUtc ? new Date(p.firstFocusBlockUtc).getUTCHours() : null;
  if (firstFocusHour === null) return null;

  const windowEnd = h.strongWindowEnd ?? h.strongWindowStart + 2;
  if (firstFocusHour < h.strongWindowStart || firstFocusHour > windowEnd) return null;

  const strongWindowLabel = `${fmt12h(h.strongWindowStart)}–${fmt12h(windowEnd)}`;
  const windowFocusMin = Math.round(p.longestFocusStreakSeconds / 60);

  const templates: string[] = [
    `You used your strongest window — ${strongWindowLabel}.\nThat block produced ${windowFocusMin}min of your best focus today.`,
    `Your ${strongWindowLabel} window is consistently your sharpest.\nToday it delivered — ${windowFocusMin}min of deep work in that block.`
  ];

  const { text } = await selectTemplate('I', templates, accountId);
  return { score: 50, message: text };
}

// Condition J — Quiet Day Fallback (score: 10)
// Always produces a result. Guaranteed message.
async function conditionJ(
  p: DailyDigestPayload,
  h: UserHistory | null,
  accountId: string,
  name: string
): Promise<ConditionResult> {
  const todayTrackedMin = Math.round(p.trackedSeconds / 60);
  const avgTrackedMin = h ? Math.round(h.avgTrackedMin) : 0;
  const daysOfData = h?.daysOfData ?? 0;
  const streak = h?.consecutiveStreak ?? 0;

  const templates: string[] = [];

  if (daysOfData >= 3 && avgTrackedMin > 0) {
    templates.push(
      `Quiet day — ${todayTrackedMin}min tracked. Your usual is ${avgTrackedMin}min.\nAri is watching. Come back tomorrow.`
    );
  }
  if (streak >= 2) {
    templates.push(
      `${name ? name + ', ' : ''}${todayTrackedMin}min today. ${streak} days tracked in a row —\nthat consistency matters more than any single session.`
    );
  }
  if (daysOfData > 0 && daysOfData < 3) {
    templates.push(
      `${todayTrackedMin}min tracked today.\nAri has ${daysOfData} day${daysOfData === 1 ? '' : 's'} of your data — the picture sharpens every session.`
    );
  }
  // Always-available fallback
  templates.push(
    `${todayTrackedMin}min of activity tracked.\nKeep showing up and Ari will get more specific about what it sees.`
  );

  const { text } = await selectTemplate('J', templates, accountId);
  return { score: 10, message: text };
}

// ── Main observation builder ──────────────────────────────────────────────────

async function buildAriObservation(
  p: DailyDigestPayload,
  h: UserHistory | null,
  firstName: string | null
): Promise<string> {
  const accountId = (p.accountId ?? '').trim();
  const name = (firstName ?? '').trim();
  const todayFocusPct = p.trackedSeconds > 0 ? Math.round((p.focusSeconds / p.trackedSeconds) * 100) : 0;
  const todayFocusScore = Math.round(p.focusQualityScore * 100);

  // No account ID — can't do template rotation; return simple fallback
  if (!accountId) {
    const min = Math.round(p.trackedSeconds / 60);
    return `${min}min of activity tracked. Keep showing up and Ari will get more specific about what it sees.`;
  }

  // Evaluate all conditions in parallel
  const results: ConditionResult[] = await Promise.all([
    h ? conditionA(p, h, accountId, name, todayFocusPct) : Promise.resolve(null),
    h ? conditionB(p, h, accountId, name, todayFocusPct, todayFocusScore) : Promise.resolve(null),
    h ? conditionC(p, h, accountId, name, todayFocusPct) : Promise.resolve(null),
    h ? conditionD(p, h, accountId, name) : Promise.resolve(null),
    conditionE(p, accountId, todayFocusPct, todayFocusScore),
    h ? conditionF(p, h, accountId) : Promise.resolve(null),
    conditionG(p, accountId),
    h ? conditionH(p, h, accountId, todayFocusPct, todayFocusScore) : Promise.resolve(null),
    h ? conditionI(p, h, accountId) : Promise.resolve(null),
    conditionJ(p, h, accountId, name),   // guaranteed non-null
  ]);

  // Pick highest score
  const winner = results
    .filter((r): r is { score: number; message: string } => r !== null)
    .sort((a, b) => b.score - a.score)[0];

  return winner?.message ?? `${Math.round(p.trackedSeconds / 60)}min tracked. Ari is watching.`;
}

// ── Subject line ──────────────────────────────────────────────────────────────

function buildSubjectLine(
  p: DailyDigestPayload,
  h: UserHistory | null,
  todayIsPersonalBest: boolean,
  dateDisplay: string
): string {
  if (h && h.consecutiveStreak >= 3) return `${h.consecutiveStreak} days in a row — ${dateDisplay}`;
  if (todayIsPersonalBest) return `Personal best today — ${dateDisplay}`;
  if (p.focusQualityScore >= 0.8) return `Strong focus day — ${dateDisplay}`;
  if (p.overloadEpisodeCount >= 3) return `High pressure day — ${dateDisplay}`;
  if (p.breaksTakenCount === 0 && p.trackedSeconds >= 5400) return `No breaks today — ${dateDisplay}`;
  return `Your Ari digest — ${dateDisplay}`;
}

// ── Category bar helper ─────────────────────────────────────────────────────────

function categoryBar(label: string, seconds: number, totalSeconds: number, color: string): string {
  const p = totalSeconds > 0 ? Math.round((seconds / totalSeconds) * 100) : 0;
  return `
    <tr>
      <td style="padding:5px 0;font-size:12px;color:#505070;width:120px;">${label}</td>
      <td style="padding:5px 8px;">
        <div style="background:#e0e0ef;border-radius:4px;height:7px;width:100%;">
          <div style="background:${color};border-radius:4px;height:7px;width:${p}%;"></div>
        </div>
      </td>
      <td style="padding:5px 0;font-size:12px;color:#505070;text-align:right;white-space:nowrap;width:64px;">${fmtMinutes(seconds)} <span style="color:#8080a0;">${p}%</span></td>
    </tr>`;
}

// ── Main builder ──────────────────────────────────────────────────────────────────────

export async function buildDigestEmail(
  p: DailyDigestPayload,
  launchUrl = 'porta://open',
  h: UserHistory | null = null,
  firstName: string | null = null
): Promise<{ subject: string; html: string }> {
  const trackedLabel = fmtMinutes(p.trackedSeconds);
  const focusLabel = fmtMinutes(p.focusSeconds);
  const focusPctLabel = pct(p.focusSeconds, p.trackedSeconds);
  const grade = focusGrade(p.focusQualityScore);
  const streakLabel = fmtMinutes(p.longestFocusStreakSeconds);
  const ariObs = await buildAriObservation(p, h, firstName);
  // Convert newlines in observation to HTML line breaks
  const ariObsHtml = ariObs.replace(/\n/g, '<br>');

  // Format date nicely: "Monday, 19 May 2025"
  let dateDisplay = p.dateLocal;
  try {
    const d = new Date(p.dateLocal + 'T00:00:00');
    dateDisplay = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    /* keep raw string */
  }

  // Determine personal best for subject line
  const todayFocusPct = p.trackedSeconds > 0 ? Math.round((p.focusSeconds / p.trackedSeconds) * 100) : 0;
  const todayFocusScore = Math.round(p.focusQualityScore * 100);
  const todayIsPersonalBest = h != null && h.daysOfData >= 5 && (
    todayFocusScore > h.bestFocusScore ||
    p.longestFocusStreakSeconds / 60 > h.bestStreakMin ||
    todayFocusPct > h.bestFocusPct
  );

  const subject = buildSubjectLine(p, h, todayIsPersonalBest, dateDisplay);

  const breakComplianceLabel =
    p.breaksSuggestedCount === 0
      ? 'No breaks suggested'
      : `${p.breaksTakenCount} of ${p.breaksSuggestedCount} taken`;

  const totalCategorySeconds =
    p.developmentSeconds + p.productivitySeconds + p.communicationSeconds + p.entertainmentSeconds;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Ari Daily Digest</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI Variable', 'Segoe UI', Helvetica, Arial, sans-serif; background-color: #f4f4f8; }
</style>
</head>
<body style="margin:0;padding:0;background:#f4f4f8;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI Variable','Segoe UI',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f4f8" style="background:#f4f4f8;min-height:100vh;">
<tr><td align="center" style="padding:32px 16px;background:#f4f4f8;">

  <!-- Card -->
  <table width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="background:#ffffff;border-radius:16px;overflow:hidden;max-width:600px;width:100%;border:1px solid #e0e0ef;">

    <!-- Header accent line -->
    <tr><td bgcolor="#5252b0" style="background:#5252b0;height:3px;font-size:0;line-height:0;">&nbsp;</td></tr>

    <!-- Header -->
    <tr>
      <td bgcolor="#ffffff" style="background:#ffffff;padding:28px 36px 24px;">
        <p style="margin:0 0 6px;font-size:11px;color:#8080b0;letter-spacing:0.1em;text-transform:uppercase;font-weight:500;">Ari by Porta</p>
        <h1 style="margin:0 0 5px;font-size:22px;font-weight:700;color:#111118;">Your day at a glance</h1>
        <p style="margin:0;font-size:13px;color:#505070;">${dateDisplay}</p>
      </td>
    </tr>

    <!-- Section 1: Day at a glance -->
    <tr>
      <td style="padding:0 36px 0;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f7f7fc" style="background:#f7f7fc;border-radius:10px;">
          <tr>
            <td style="text-align:center;padding:20px 8px 20px 0;">
              <p style="margin:0 0 4px;font-size:11px;color:#8080a0;text-transform:uppercase;letter-spacing:0.06em;">Tracked</p>
              <p style="margin:0;font-size:26px;font-weight:700;color:#111118;">${trackedLabel}</p>
            </td>
            <td style="text-align:center;padding:20px 8px;border-left:1px solid #e0e0ef;border-right:1px solid #e0e0ef;">
              <p style="margin:0 0 4px;font-size:11px;color:#8080a0;text-transform:uppercase;letter-spacing:0.06em;">Focus</p>
              <p style="margin:0;font-size:26px;font-weight:700;color:#5252a0;">${focusLabel}</p>
              <p style="margin:0;font-size:12px;color:#8080a0;">${focusPctLabel} of day</p>
            </td>
            <td style="text-align:center;padding:20px 0 20px 8px;">
              <p style="margin:0 0 4px;font-size:11px;color:#8080a0;text-transform:uppercase;letter-spacing:0.06em;">Quality</p>
              <p style="margin:0;font-size:26px;font-weight:700;color:${grade.color};">${grade.label}</p>
              <p style="margin:0;font-size:12px;color:#8080a0;">${Math.round(p.focusQualityScore * 100)}/100</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Divider -->
    <tr><td style="padding:22px 36px 0;"><div style="height:1px;background:#e0e0ef;"></div></td></tr>

    <!-- Section 2: Focus quality -->
    <tr>
      <td style="padding:20px 36px 0;">
        <p style="margin:0 0 14px;font-size:11px;font-weight:600;color:#5050a0;text-transform:uppercase;letter-spacing:0.1em;">Focus Quality</p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="padding:0 16px 0 0;">
              <p style="margin:0 0 2px;font-size:12px;color:#8080a0;">Longest streak</p>
              <p style="margin:0;font-size:19px;font-weight:600;color:#111118;">${streakLabel}</p>
            </td>
            <td style="padding:0 16px;border-left:1px solid #e0e0ef;">
              <p style="margin:0 0 2px;font-size:12px;color:#8080a0;">Fragmentation</p>
              <p style="margin:0;font-size:19px;font-weight:600;color:#111118;">${p.fragmentationEpisodeCount} <span style="font-size:12px;color:#8080a0;">episodes</span></p>
            </td>
            <td style="padding:0 0 0 16px;border-left:1px solid #e0e0ef;">
              <p style="margin:0 0 2px;font-size:12px;color:#8080a0;">Context switches</p>
              <p style="margin:0;font-size:19px;font-weight:600;color:#111118;">${fmtMinutes(p.contextExcursionSeconds)}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Divider -->
    <tr><td style="padding:20px 36px 0;"><div style="height:1px;background:#e0e0ef;"></div></td></tr>

    <!-- Section 3: Distraction patterns -->
    <tr>
      <td style="padding:20px 36px 0;">
        <p style="margin:0 0 14px;font-size:11px;font-weight:600;color:#b06030;text-transform:uppercase;letter-spacing:0.1em;">Distraction Patterns</p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="padding:0 12px 0 0;vertical-align:top;">
              <p style="margin:0 0 2px;font-size:12px;color:#8080a0;">Total distraction</p>
              <p style="margin:0;font-size:18px;font-weight:600;color:#b05020;">${fmtMinutes(p.distractionSeconds)}</p>
            </td>
            <td style="padding:0 12px;border-left:1px solid #e0e0ef;vertical-align:top;">
              <p style="margin:0 0 2px;font-size:12px;color:#8080a0;">Social media loops</p>
              <p style="margin:0;font-size:18px;font-weight:600;color:#111118;">${p.socialMediaLoopCount}×</p>
              <p style="margin:0;font-size:11px;color:#8080a0;">${fmtMinutes(p.socialMediaSeconds)}</p>
            </td>
            <td style="padding:0 0 0 12px;border-left:1px solid #e0e0ef;vertical-align:top;">
              <p style="margin:0 0 2px;font-size:12px;color:#8080a0;">Gaming</p>
              <p style="margin:0;font-size:18px;font-weight:600;color:#111118;">${fmtMinutes(p.gamingLauncherSeconds + p.gamingActiveSeconds)}</p>
              <p style="margin:0;font-size:11px;color:#8080a0;">${p.gamingEpisodeCount} episodes</p>
            </td>
          </tr>
        </table>
        ${p.mostDistractedHourLabel && p.mostDistractedHourLabel !== 'n/a'
          ? `<p style="margin:12px 0 0;font-size:13px;color:#606080;">Most distracted hour: <span style="color:#b05020;font-weight:600;">${p.mostDistractedHourLabel}</span></p>`
          : ''}
      </td>
    </tr>

    <!-- Divider -->
    <tr><td style="padding:20px 36px 0;"><div style="height:1px;background:#e0e0ef;"></div></td></tr>

    <!-- Section 4: Pressure & Breaks -->
    <tr>
      <td style="padding:20px 36px 0;">
        <p style="margin:0 0 14px;font-size:11px;font-weight:600;color:#8a406a;text-transform:uppercase;letter-spacing:0.1em;">Pressure &amp; Breaks</p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="padding:0 16px 0 0;">
              <p style="margin:0 0 2px;font-size:12px;color:#8080a0;">Overload episodes</p>
              <p style="margin:0;font-size:19px;font-weight:600;color:${p.overloadEpisodeCount >= 3 ? '#c04055' : '#111118'};">${p.overloadEpisodeCount}</p>
            </td>
            <td style="padding:0 0 0 16px;border-left:1px solid #e0e0ef;">
              <p style="margin:0 0 2px;font-size:12px;color:#8080a0;">Break compliance</p>
              <p style="margin:0;font-size:19px;font-weight:600;color:#111118;">${breakComplianceLabel}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Divider -->
    <tr><td style="padding:20px 36px 0;"><div style="height:1px;background:#e0e0ef;"></div></td></tr>

    <!-- Section 5: App category breakdown -->
    <tr>
      <td style="padding:20px 36px 0;">
        <p style="margin:0 0 14px;font-size:11px;font-weight:600;color:#207a80;text-transform:uppercase;letter-spacing:0.1em;">Time Breakdown</p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${categoryBar('Development', p.developmentSeconds, totalCategorySeconds, '#5858a0')}
          ${categoryBar('Productivity', p.productivitySeconds, totalCategorySeconds, '#207a80')}
          ${categoryBar('Communication', p.communicationSeconds, totalCategorySeconds, '#287858')}
          ${categoryBar('Entertainment', p.entertainmentSeconds, totalCategorySeconds, '#a05830')}
        </table>
      </td>
    </tr>

    <!-- Divider -->
    <tr><td style="padding:20px 36px 0;"><div style="height:1px;background:#e0e0ef;"></div></td></tr>

    <!-- Section 6: Ari observation -->
    <tr>
      <td style="padding:20px 36px 0;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td bgcolor="#f7f7fc" style="background:#f7f7fc;border-left:3px solid #5252b0;border-radius:0 8px 8px 0;padding:14px 16px;">
              <p style="margin:0 0 6px;font-size:11px;font-weight:600;color:#8080b0;text-transform:uppercase;letter-spacing:0.1em;">Ari's observation</p>
              <p style="margin:0;font-size:14px;color:#505070;line-height:1.6;">${ariObsHtml}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- CTA -->
    <tr>
      <td style="padding:28px 36px 32px;text-align:center;">
        <a href="${launchUrl}" style="display:inline-block;background:#3d3d9a;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 36px;border-radius:8px;letter-spacing:0.04em;border:1px solid #3030a0;">Open Ari</a>
      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td bgcolor="#f4f4f8" style="background:#f4f4f8;padding:16px 36px;text-align:center;border-radius:0 0 16px 16px;border-top:1px solid #e0e0ef;">
        <p style="margin:0;font-size:11px;color:#8080a0;">Sent by Ari · <a href="https://useporta.com" style="color:#5050a0;text-decoration:none;">useporta.com</a></p>
      </td>
    </tr>

  </table>
  <!-- End card -->

</td></tr>
</table>
</body>
</html>`;

  return { subject, html };
}
