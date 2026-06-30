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
  /** The day's average expressive pressure (0–100 pct). Used to detect a high-pressure
   *  day relative to the user's own baseline, instead of the conservative overload count. */
  pressureAvgPct?: number;
  avgDistractionEpisodeDurationSeconds?: number;
  contextSwitchCount?: number;
  preLongestDistractionFocusSeconds?: number;
  // Digest honesty — fields below let senders declare what they DON'T know,
  // so the email renders "no data" instead of a confident zero.
  /** Metrics whose source store had no data for this day. */
  missingFields?: ReadonlyArray<DigestMissingField>;
  /** True when assembled by the server cron from periodic stats (machine was offline at send time). */
  isServerFallback?: boolean;
  /** Per-app foreground time for the day — coarse label + seconds + category (0=Unknown).
   * Powers "Where your time went" and "What pulled you off task". */
  topApps?: ReadonlyArray<{ label: string; seconds: number; category?: number }>;
}

export type DigestMissingField = 'gaming' | 'socialMedia' | 'contextSwitches' | 'streak' | 'fragmentation';

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

  const threshold = Math.round(h.avgFocusPct);
  const templates: string[] = [];

  if (hasStreak) {
    templates.push(
      `${name ? name + ', ' : ''}${h.consecutiveStreak} days in a row with focus above ${threshold}%.\nSomething is working — don't break the chain.`
    );
    templates.push(
      `${h.consecutiveStreak} consecutive days above your average.\nYour best streak this month is ${h.consecutiveStreak} days. Keep going.`
    );
  }
  if (hasTrend) {
    templates.push(
      `Focus has been climbing for ${Math.min(h.daysOfData, 7)} days straight.\nAri doesn't say this often: you're in a rhythm.`
    );
  }
  if (hasStreak && hasTrend) {
    templates.push(
      `${h.consecutiveStreak} days tracked in a row.\nYour focus average this week is ${todayFocusPct}% — your best stretch this month.`
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

  if (isBestStreak) {
    templates.push(
      `${name ? name + ', your' : 'Your'} ${Math.round(todayStreakMin)}min focus run today is your longest ever recorded.\nAri noticed.`
    );
  }
  if (isBestScore) {
    templates.push(
      `Best focus score of the month — ${todayFocusScore}.\nYour previous best was ${Math.round(h.bestFocusScore)} on ${formatPastDate(h.bestFocusScoreDate)}.`
    );
  }
  if (isBestFocusPct) {
    templates.push(
      `${todayFocusPct}% focus rate today — personal record.\nYour previous best was ${Math.round(h.bestFocusPct)}%.`
    );
  }
  // Early start variant — if first focus was early (before 9am local)
  if (p.firstFocusBlockUtc) {
    const firstHour = new Date(p.firstFocusBlockUtc).getUTCHours();
    if (firstHour < 9) {
      const timeLabel = fmt12h(firstHour);
      templates.push(
        `You hit deep work at ${timeLabel}.\nEarliest start Ari has seen from you.`
      );
    }
  }

  if (templates.length === 0) return null;

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

// "High pressure day" detection.
//
// The conservative overloadEpisodeCount (overloadActive activations) almost never fires in
// the field, so gating high-pressure messaging on it alone left this path effectively dead.
// We now ALSO treat a day whose average expressive pressure ran clearly above the user's own
// rolling baseline as high-pressure. This is self-calibrating — it compares against the user's
// normal, not an absolute cutoff — so it holds regardless of the pressure model's absolute
// range and survives the agent's pressure recalibration without re-tuning.
export const HIGH_PRESSURE_BASELINE_FACTOR = 1.3;
export const HIGH_PRESSURE_MIN_DELTA_PCT = 8;

export function isHighPressureDay(p: DailyDigestPayload, h: UserHistory | null): boolean {
  // Strong conservative signal: real overload activations, on the rare days they happen.
  if (p.overloadEpisodeCount >= 2) return true;
  // Expressive signal: today's average pressure clearly above the user's own baseline.
  const dayPct = p.pressureAvgPct;
  const baselinePct = h?.avgPressurePct ?? 0;
  return (
    dayPct != null &&
    baselinePct > 0 &&
    dayPct >= baselinePct * HIGH_PRESSURE_BASELINE_FACTOR &&
    dayPct - baselinePct >= HIGH_PRESSURE_MIN_DELTA_PCT
  );
}

// Condition D — Pressure Pattern (score: 75)
// Minimum 7 days. Fires when pressure is elevated (above baseline or real overload events)
// OR peak pressure matched the user's weak hour.
async function conditionD(
  p: DailyDigestPayload,
  h: UserHistory,
  accountId: string,
  name: string
): Promise<ConditionResult> {
  if (h.daysOfData < 7) return null;

  const contextSwitchCount = p.contextSwitchCount ?? 0;
  const isHighPressure = isHighPressureDay(p, h);

  const peakHour = p.peakPressureUtc ? new Date(p.peakPressureUtc).getUTCHours() : null;
  const matchesWeakHour = h.weakHour != null && peakHour !== null && peakHour === h.weakHour;

  if (!isHighPressure && !matchesWeakHour) return null;

  const templates: string[] = [];

  const dateObj = new Date(p.dateLocal + 'T00:00:00');
  const dayName = DAY_NAMES[dateObj.getDay()] ?? 'today';

  if (matchesWeakHour && h.weakHour != null) {
    const peakLabel = fmt12h(peakHour!);
    templates.push(
      `Pressure peaked at ${peakLabel} — same window as your most difficult ${dayName}s.\nThat's a pattern worth knowing.`
    );
  }
  if (isHighPressure && contextSwitchCount > 0) {
    templates.push(
      `High pressure ${dayName}: your pressure ran well above your normal.\n${contextSwitchCount} context switches contributed. Wind down properly tonight.`
    );
  }
  if (isHighPressure) {
    templates.push(
      `${name ? name + ', pressure' : 'Pressure'} ran above your normal today.\nThat usually predicts a harder next morning. Wind down properly tonight.`
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

  // Fast recovery variant leads — most positive framing
  if (aboveCount && belowDur) {
    templates.push(
      `${distractionCount} distraction episodes today.\nYou recovered from each in under ${avgDistrMin}min — faster than your average of ${Math.round(h.avgDistractionDurMin)}min.`
    );
  }
  if (aboveCount && !belowDur) {
    templates.push(
      `You drifted ${distractionCount} times. Average drift was ${avgDistrMin}min.\nTotal focus lost: ${totalLostMin}min.`
    );
  }
  if (socialLoops) {
    templates.push(
      `You returned to social media ${p.socialMediaLoopCount} times today.\nYour typical is lower. That's a pattern worth watching.`
    );
  }
  if (h.weakHour != null && aboveCount) {
    templates.push(
      `Drift episodes spiked around ${fmt12h(h.weakHour)}.\nThat's been your weak window. Worth protecting.`
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
      `No breaks across ${todayTrackedH}h of work.\nAri suggested ${p.breaksSuggestedCount}. Your call — but the last hour showed it.`
    );
  }
  if (allBreaksTaken) {
    templates.push(
      `You took every break Ari suggested today — ${p.breaksTakenCount} of ${p.breaksSuggestedCount}.\nRecovery compliance like that is rare. Your afternoon focus reflected it.`
    );
  }
  if (!allBreaksTaken && p.breaksTakenCount > 0 && missed > 0 && peakHour !== null) {
    templates.push(
      `${p.breaksTakenCount} of ${p.breaksSuggestedCount} breaks taken.\nThe ${missed} you skipped coincided with your pressure spike at ${fmt12h(peakHour)}.`
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

  const dateObj = new Date(p.dateLocal + 'T00:00:00');
  const prevDow = new Date(dateObj.getTime() - 86400000).getDay();
  const prevDayName = DAY_NAMES[prevDow] ?? 'yesterday';

  const templates: string[] = [
    `Back above your average after a rough ${prevDayName}.\n${todayFocusScore} today — your mean is ${Math.round(h.avgFocusScore)}. Good recovery.`,
    `${todayFocusPct}% focus today, up from yesterday.\nAbove your average of ${Math.round(h.avgFocusPct)}% for the first time this week.`
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
    `You used your strongest window — ${strongWindowLabel}.\nThat block alone produced ${windowFocusMin}min of deep work.`,
    `Your ${strongWindowLabel} window is consistently your best.\nToday it produced ${windowFocusMin}min of focus. Protect it tomorrow.`
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

  const todayFocusMin = Math.round(p.focusSeconds / 60);

  if (daysOfData >= 3 && avgTrackedMin > 0) {
    templates.push(
      `Quiet day — ${todayTrackedMin}min tracked. Your usual is ${avgTrackedMin}min.\nAri is watching. Come back tomorrow.`
    );
  }
  if (streak >= 2) {
    templates.push(
      `${name ? name + ', ' : ''}${todayTrackedMin}min today. Not your best, not your worst.\n${streak} days tracked in a row. That matters more than any single day.`
    );
  }
  if (todayFocusMin > 0 && daysOfData >= 1) {
    templates.push(
      `Light day. ${todayFocusMin}min of focus from ${todayTrackedMin}min tracked.\nAri has ${daysOfData} day${daysOfData === 1 ? '' : 's'} of your data now — the picture is sharpening.`
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

// Condition K — Focus Identity (score: 40)
// Minimum 14 days + at least 3 DOW entries with ≥10-point spread.
// Surfaces the user's strongest/weakest days and peak window as identity, not comparison.
// Fires on ordinary days when no reactive condition wins — tells you who you are, not what today was.
async function conditionK(
  p: DailyDigestPayload,
  h: UserHistory,
  accountId: string
): Promise<ConditionResult> {
  if (h.daysOfData < 14) return null;

  const entries = Object.entries(h.dowAvgFocusPct)
    .map(([dow, pct]) => ({ dow: Number(dow), pct }))
    .sort((a, b) => b.pct - a.pct);

  if (entries.length < 3) return null;

  const topPct = entries[0]!.pct;
  const bottomPct = entries[entries.length - 1]!.pct;
  // No meaningful pattern if all days are within 10 points of each other
  if (topPct - bottomPct < 10) return null;

  const top1 = entries[0]!;
  const top2 = entries[1] ?? null;
  const weakest = entries[entries.length - 1]!;

  const top1Name = DAY_NAMES[top1.dow] ?? 'that day';
  const top2Name = top2 ? (DAY_NAMES[top2.dow] ?? null) : null;
  const weakName = DAY_NAMES[weakest.dow] ?? 'that day';

  // UTC strong window → local time label
  let windowLabel: string | null = null;
  if (h.strongWindowStart != null) {
    const localHour = Math.floor(((h.strongWindowStart + p.timezoneOffsetMinutes / 60) % 24 + 24) % 24);
    const localEnd = (localHour + 2) % 24;
    windowLabel = `${fmt12h(localHour)}–${fmt12h(localEnd)}`;
  }

  const templates: string[] = [];

  // Best two days + weakest day
  if (top2 && top2Name) {
    templates.push(
      `${top1Name} and ${top2Name} are your strongest days — you average ${Math.round(top1.pct)}% and ${Math.round(top2.pct)}% focus.\n${weakName} tends to be your softest at ${Math.round(weakest.pct)}%.`
    );
  }

  // Best days + time window combined
  if (windowLabel && top2 && top2Name) {
    templates.push(
      `Your best work happens on ${top1Name}s and ${top2Name}s, with focus peaking between ${windowLabel}.\nProtecting that window on those days is worth more than any single tactic.`
    );
  }

  // Window identity alone
  if (windowLabel) {
    templates.push(
      `Your focus peaks between ${windowLabel} — that's when your quality scores are consistently highest.\n${top1Name} is your best day to use it.`
    );
  }

  // Quiet-day framing — always available as fallback within this condition
  templates.push(
    `Nothing unusual today — but across your data, ${top1Name} is your most consistent peak day.\nWorth protecting that one next week.`
  );

  const { text } = await selectTemplate('K', templates, accountId);
  return { score: 40, message: text };
}

// Condition L — Drift Pattern (score: 35)
// Minimum 14 days. Fires when avgFocusEpisodeDurMin is in a meaningful range (10–90 min).
// Observational only — surfaces the user's typical focus run length before context-switching.
async function conditionL(
  h: UserHistory,
  accountId: string
): Promise<ConditionResult> {
  if (h.daysOfData < 14) return null;

  const episodeMin = h.avgFocusEpisodeDurMin;
  if (episodeMin < 10 || episodeMin > 90) return null;

  // Round to nearest 5 for natural phrasing ("~35 minutes" not "~33 minutes")
  const rounded = Math.round(episodeMin / 5) * 5;
  const label = `~${rounded} minutes`;

  const templates: string[] = [
    `Your average focus run is ${label} before a context switch.\nThat's your natural episode length — Ari has seen it consistently across ${h.daysOfData} days.`,
    `Across your data, you typically stay in deep work for ${label} before drifting.\nThat window is real — it shows up day after day.`,
    `${label} of focused work, then a context switch. That's your pattern.\nAri has tracked it across ${h.daysOfData} days now.`,
    `Your focus episodes average ${label}. On your best days that number climbs — on high-pressure days it compresses.\nThe baseline is ${label}.`,
  ];

  const { text } = await selectTemplate('L', templates, accountId);
  return { score: 35, message: text };
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
    h ? conditionK(p, h, accountId) : Promise.resolve(null),
    h ? conditionL(h, accountId) : Promise.resolve(null),
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
  if (isHighPressureDay(p, h)) return `High pressure day — ${dateDisplay}`;
  if (p.breaksTakenCount === 0 && p.trackedSeconds >= 5400) return `No breaks today — ${dateDisplay}`;
  return `Your Ari digest — ${dateDisplay}`;
}

// ── No-data helper ──────────────────────────────────────────────────────────────
// Rendered wherever a metric's source store had no data. A confident "0m" for a
// broken sensor destroys trust in the numbers that ARE real.

const NO_DATA_HTML = '<span style="color:#b0b0c8;font-weight:500;font-size:15px;">no data</span>';

/**
 * Missing-field set: explicit declarations from the sender, plus logical
 * contradictions the builder can detect on its own:
 * - a zero "longest streak" on a day with ≥30m of focus is impossible — the
 *   streak field arrived broken, not as a real zero;
 * - zero distraction episodes alongside ≥30m of distraction time is equally
 *   impossible — episode detection was not delivering.
 */
function resolveMissingFields(p: DailyDigestPayload): Set<DigestMissingField> {
  const missing = new Set<DigestMissingField>(p.missingFields ?? []);
  if (p.longestFocusStreakSeconds <= 0 && p.focusSeconds >= 1800) missing.add('streak');
  if (p.fragmentationEpisodeCount === 0 && p.distractionSeconds >= 1800) missing.add('fragmentation');
  return missing;
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
  const missing = resolveMissingFields(p);
  const streakLabel = missing.has('streak') ? NO_DATA_HTML : fmtMinutes(p.longestFocusStreakSeconds);
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
    (!missing.has('streak') && p.longestFocusStreakSeconds / 60 > h.bestStreakMin) ||
    todayFocusPct > h.bestFocusPct
  );

  const subject = buildSubjectLine(p, h, todayIsPersonalBest, dateDisplay);

  const breakComplianceLabel =
    p.breaksSuggestedCount === 0
      ? 'No breaks suggested'
      : `${p.breaksTakenCount} of ${p.breaksSuggestedCount} taken`;

  // "Where your time went" — real named apps/sites with time. Coarse labels only.
  const topAppsList = (p.topApps ?? []).filter((a) => a && typeof a.label === 'string' && a.seconds > 0).slice(0, 6);
  const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const prettyAppLabel = (s: string) => (s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1));
  const topAppsHtml = topAppsList.length === 0
    ? ''
    : `
    <!-- Section: Where your time went -->
    <tr>
      <td style="padding:24px 36px 0;">
        <p style="margin:0 0 10px;font-size:11px;color:#8080a0;text-transform:uppercase;letter-spacing:0.06em;">Where your time went</p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${topAppsList.map((a) => `<tr>
            <td style="padding:6px 0;font-size:14px;color:#111118;font-weight:500;">${escHtml(prettyAppLabel(a.label))}</td>
            <td style="padding:6px 0;font-size:14px;color:#505070;text-align:right;">${fmtMinutes(a.seconds)}</td>
          </tr>`).join('')}
        </table>
      </td>
    </tr>`;

  // "What pulled you off task" — the distracting apps/sites (entertainment, social, gaming),
  // attributed by name. Coarse categories: 1=Entertainment, 3=SocialMedia, 4=Gaming, 7=GamingLauncher.
  const distractingCategories = new Set([1, 3, 4, 7]);
  const distractingApps = (p.topApps ?? [])
    .filter((a) => a && typeof a.label === 'string' && a.seconds > 0 && distractingCategories.has(a.category ?? 0))
    .slice(0, 5);
  const distractionHtml = distractingApps.length === 0
    ? ''
    : `
    <!-- Section: What pulled you off task -->
    <tr>
      <td style="padding:24px 36px 0;">
        <p style="margin:0 0 10px;font-size:11px;color:#8080a0;text-transform:uppercase;letter-spacing:0.06em;">What pulled you off task</p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${distractingApps.map((a) => `<tr>
            <td style="padding:6px 0;font-size:14px;color:#111118;font-weight:500;">${escHtml(prettyAppLabel(a.label))}</td>
            <td style="padding:6px 0;font-size:14px;color:#a05050;text-align:right;">${fmtMinutes(a.seconds)}</td>
          </tr>`).join('')}
        </table>
      </td>
    </tr>`;

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
        ${p.isServerFallback
          ? '<p style="margin:8px 0 0;font-size:11px;color:#a06030;">Your machine was offline at send time — this digest was assembled from stats reported during the day. Activity after the last report is not included.</p>'
          : ''}
      </td>
    </tr>

    ${topAppsHtml}

    ${distractionHtml}

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
              <p style="margin:0;font-size:19px;font-weight:600;color:#111118;">${missing.has('fragmentation') ? NO_DATA_HTML : `${p.fragmentationEpisodeCount} <span style="font-size:12px;color:#8080a0;">episodes</span>`}</p>
            </td>
            <td style="padding:0 0 0 16px;border-left:1px solid #e0e0ef;">
              <p style="margin:0 0 2px;font-size:12px;color:#8080a0;">Context switches</p>
              <p style="margin:0;font-size:19px;font-weight:600;color:#111118;">${missing.has('contextSwitches') ? NO_DATA_HTML : fmtMinutes(p.contextExcursionSeconds)}</p>
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
              ${missing.has('socialMedia')
                ? `<p style="margin:0;">${NO_DATA_HTML}</p>`
                : `<p style="margin:0;font-size:18px;font-weight:600;color:#111118;">${p.socialMediaLoopCount}×</p>
              <p style="margin:0;font-size:11px;color:#8080a0;">${fmtMinutes(p.socialMediaSeconds)}</p>`}
            </td>
            <td style="padding:0 0 0 12px;border-left:1px solid #e0e0ef;vertical-align:top;">
              <p style="margin:0 0 2px;font-size:12px;color:#8080a0;">Gaming</p>
              ${missing.has('gaming')
                ? `<p style="margin:0;">${NO_DATA_HTML}</p>`
                : `<p style="margin:0;font-size:18px;font-weight:600;color:#111118;">${fmtMinutes(p.gamingLauncherSeconds + p.gamingActiveSeconds)}</p>
              <p style="margin:0;font-size:11px;color:#8080a0;">${p.gamingEpisodeCount} episodes</p>`}
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

    <!-- App-category section removed: the four categories were derived from
         focus strength, not real app usage. Reinstate only when genuine
         app-category attribution ships in the agent. -->

    <!-- Section 5: Ari observation -->
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
