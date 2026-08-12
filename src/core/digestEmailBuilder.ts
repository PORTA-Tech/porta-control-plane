import type { UserHistory } from '../store/userHistoryStore.js';
import { buildAriTake } from './digestNarrative.js';
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
  /**
   * C1 — the day's stated morning goal (Workstream D check-ins) and the midday
   * yes/partly/not_yet answer. The digest leads with goal vs reality; null/absent means the user
   * set no goal that day, and the Goal section is omitted rather than rendered empty.
   */
  goal?: string | null;
  middayAnswer?: string | null;
  /** Per-app foreground time for the day — coarse label + seconds + category (0=Unknown).
   * Powers "Where your time went" and "What pulled you off task". */
  topApps?: ReadonlyArray<{ label: string; seconds: number; category?: number }>;
  /** W4 — plan vs. reality: the day's task board, exactly the measured numbers.
   * Empty/absent → the section is omitted entirely (grounding rule: no padding, ever).
   * Since the 2026-08-11 redesign this is the WHOLE board (open tasks included), because the
   * headline scores planned-vs-finished the same way the evening card does. */
  tasks?: ReadonlyArray<DigestTaskEntry>;
  /** Digest redesign (2026-08-11) — the shape of the day, one entry per local hour that recorded
   * something. Hours that recorded nothing are ABSENT, never zeroed: "nothing recorded" (machine
   * off) is a different claim from "away" (there, but idle), and the strip renders the difference.
   * Empty/absent → THE DAY section is omitted entirely. Agents before 1.2.140 never send it. */
  dayTimeline?: ReadonlyArray<DigestTimelineHour>;
}

export interface DigestTaskEntry {
  title: string;
  plannedSeconds: number;
  actualSeconds: number;
  offtaskSeconds: number;
  /** done | abandoned | pending — the board's own state. Only 'done' counts as finished. */
  state: string;
  /** The goal-day this task was moved to by the close-out card. Empty = not moved.
   * A moved task reads "moved on" — never as a failure. */
  deferredUntilDay?: string;
}

/** One local hour of the day's shape. Focus + active + away are the capture pipeline's OWN
 * attention classification — no new inference, so the strip cannot disagree with the per-task
 * numbers. */
export interface DigestTimelineHour {
  hourLocal: number;
  focusSeconds: number;
  activeSeconds: number;
  awaySeconds: number;
}

/** W5 — residual honesty: agents label unrecognized browser pages "web"; newer agents
 * already send "Other browsing", but stats stored by older agents still say "web".
 *
 * Since the 2026-08-11 redesign the email does not print residue AT ALL — not "web", not
 * "Other browsing", not "Unnamed". "Where your time went" is a ranking of top sites, not an
 * accounting of every minute, so it never claimed to add up; the honest totals are the four
 * figures. This constant is now the residue MATCHER (see `isResidueLabel`). */
export const RESIDUAL_BROWSING_LABEL = 'Other browsing';
/**
 * Escapes text before it goes into the email HTML. A function declaration (not a const arrow) so
 * it is hoisted and usable anywhere in the builder — the goal is user-typed free text rendered
 * near the top of the message, well above where the local `escHtml` helper is defined.
 */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export type DigestMissingField = 'gaming' | 'socialMedia' | 'contextSwitches' | 'streak' | 'fragmentation';

// ── Formatting helpers ──────────────────────────────────────────────

/** "8h 35m" / "1h 07m" / "2h" / "42m" — minutes zero-padded beside hours, exactly as the mock
 *  prints them, so a column of times stays visually aligned. */
function fmtMinutes(seconds: number): string {
  const m = Math.round(Math.max(0, seconds) / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${String(rem).padStart(2, '0')}m`;
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

  // Grounding audit (W5): every sentence here must trace to a field. No invented
  // superlatives ("best this month") and no relabeled numbers (today's pct is not a
  // "week average").
  if (hasStreak) {
    templates.push(
      `${name ? name + ', ' : ''}${h.consecutiveStreak} days in a row with focus above ${threshold}%.\nSomething is working — don't break the chain.`
    );
    templates.push(
      `${h.consecutiveStreak} consecutive days above your average.\nKeep going.`
    );
  }
  if (hasTrend) {
    templates.push(
      `Focus has been climbing for ${Math.min(h.daysOfData, 7)} days straight.\nAri doesn't say this often: you're in a rhythm.`
    );
  }
  if (hasStreak && hasTrend) {
    templates.push(
      `${h.consecutiveStreak} days tracked in a row, and the trend is still climbing.\nToday closed at ${todayFocusPct}% focus.`
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
      `Best focus score Ari has recorded for you — ${todayFocusScore}.\nYour previous best was ${Math.round(h.bestFocusScore)} on ${formatPastDate(h.bestFocusScoreDate)}.`
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
      // "Earliest Ari has seen" was never verified against history — say only what
      // the payload actually shows: an early first focus block.
      const timeLabel = fmt12h(firstHour);
      templates.push(
        `You hit deep work at ${timeLabel}.\nAn early start.`
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
    // "best ${dayName} this month" was never verified — the data shows above-average,
    // so that is exactly what gets said.
    templates.push(
      `${name ? name + ', your' : 'Your'} ${todayFocusPct}% focus rate today is well above your ${dayName} average.\n${dayName}s average ${Math.round(dowAvg)}% for you.`
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
      `${name ? name + ', pressure' : 'Pressure'} ran above your normal today.\nWind down properly tonight.`
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
      `${todayFocusPct}% focus time today, but quality score only ${todayFocusScore}.\nTime in seat, but not fully there.`
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
    // "Your typical is lower" was never checked against history — the count alone is
    // the fact, so the count is what gets said.
    templates.push(
      `You returned to social media ${p.socialMediaLoopCount} times today.\nThat's a pattern worth watching.`
    );
  }
  if (h.weakHour != null && aboveCount) {
    // The payload doesn't say WHEN today's episodes happened — only history knows the
    // weak window. Say each fact as what it is.
    templates.push(
      `More drift episodes than your usual today.\nYour weak window has historically been around ${fmt12h(h.weakHour)}. Worth protecting.`
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

  // Grounding audit (W5): the payload has counts and the pressure peak hour — it does
  // NOT say what "the last hour showed", how the afternoon went, or when the skipped
  // breaks happened. Only the measured facts get said.
  if (noBreaksTaken) {
    templates.push(
      `No breaks across ${todayTrackedH}h of work.\nAri suggested ${p.breaksSuggestedCount}. Your call.`
    );
  }
  if (allBreaksTaken) {
    templates.push(
      `You took every break Ari suggested today — ${p.breaksTakenCount} of ${p.breaksSuggestedCount}.`
    );
  }
  if (!allBreaksTaken && p.breaksTakenCount > 0 && missed > 0 && peakHour !== null) {
    templates.push(
      `${p.breaksTakenCount} of ${p.breaksSuggestedCount} breaks taken.\nPressure peaked at ${fmt12h(peakHour)}.`
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

  // Grounding audit (W5): the condition verifies SCORE above average — the templates
  // must not switch to focus-% claims, and "first time this week" was never checked.
  const templates: string[] = [
    `Back above your average after a rough ${prevDayName}.\n${todayFocusScore} today — your mean is ${Math.round(h.avgFocusScore)}. Good recovery.`,
    `Focus score ${todayFocusScore} today, up from yesterday.\nAbove your average of ${Math.round(h.avgFocusScore)}.`
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

  // Grounding audit (W5): the payload shows the day STARTED in the strong window and the
  // day's longest streak — it does not attribute the streak to that window.
  const templates: string[] = [
    `You started in your strongest window — ${strongWindowLabel}.\nLongest focus run today: ${windowFocusMin}min.`,
    `Your ${strongWindowLabel} window is consistently your best.\nToday's longest focus run was ${windowFocusMin}min. Protect that window tomorrow.`
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

// ── The design values ─────────────────────────────────────────────────────────────────
// Ported verbatim from Digest_Redesign_Mock.html (the mock Yadin approved). These are the
// START_HERE §4 design values. Do not change them without asking.
//
// THE GREEN RULE: #3FBF7F means work that COUNTED — a finished task, a finished bar, focused
// time on the timeline, and the primary button. Nothing else, ever.

const PAGE_BG = '#0B0D11';
const CARD_BG = '#14171C';
const HAIRLINE = '#2A3038';
const HEADLINE = '#F2F4F7';
const BODY = '#DFE3E9';
const MUTED = '#8B929E';
const META = '#6F7885';
const ACCENT = '#3FBF7F';
const ACCENT_TEXT = '#0E2A1C';
const AT_MACHINE = '#5A626D';
/** Away fill on the strip, and the empty half of every bar. */
const AWAY = '#232931';
const AWAY_EDGE = '#3A424C';
/** The bare timeline track. Measured: it must read visibly EMPTIER than away — #1B1F26 was
 *  tried first and read as away, which is the one thing a gap must never look like. */
const GAP_TRACK = '#171A20';

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";

const LABEL_STYLE = `font-size:10px;color:${META};text-transform:uppercase;`;

function spacer(px: number): string {
  return `<div style="height:${px}px;"></div>`;
}

/** The 0.5px hairline between sections. */
function ruleRow(padTop = 20): string {
  return `<tr><td style="padding:${padTop}px 32px 0 32px;"><div style="height:0.5px;background:${HAIRLINE};font-size:0;line-height:0;">&nbsp;</div></td></tr>`;
}

// ── No-data helper ──────────────────────────────────────────────────────────────
// Rendered wherever a metric's source store had no data. A confident "0m" for a
// broken sensor destroys trust in the numbers that ARE real.

const NO_DATA_HTML = `<span style="color:${META};font-size:17px;">no data</span>`;

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

// ── 5. The headline ───────────────────────────────────────────────────────────────────
//
// Scored through the SAME rule as UserCheckInTaskBoard.SummarizeDay: planned = every task on
// the board, finished = state 'done'. This is the whole point of the agent sending OPEN tasks.
// If it is ever reimplemented differently, the evening card and the email disagree again —
// which is the exact bug this replaced.

function spell(n: number): string {
  switch (n) {
    case 1: return 'one';
    case 2: return 'two';
    case 3: return 'three';
    default: return String(n);
  }
}

/** The two lines of the headline, or null when nothing was planned — a day with no board gets
 *  no invented summary, exactly as the card gets none. */
export function summarizeDay(tasks: ReadonlyArray<DigestTaskEntry>): { planned: string; finished: string } | null {
  const planned = tasks.length;
  if (planned === 0) return null;

  const finished = tasks.filter((t) => t.state === 'done').length;
  const plannedPart = planned === 1 ? 'You planned one thing.' : `You planned ${spell(planned)} things.`;

  let finishedPart: string;
  if (planned === 1) {
    // "You finished one" reads oddly straight after "You planned one thing".
    finishedPart = finished === 1 ? 'You finished it.' : "You didn't get to it.";
  } else if (finished === 0) {
    finishedPart = 'You finished none of them.';
  } else if (finished === planned) {
    finishedPart = 'You finished them all.';
  } else if (finished === 1) {
    finishedPart = 'You finished one.';
  } else {
    finishedPart = `You finished ${spell(finished)}.`;
  }

  return { planned: plannedPart, finished: finishedPart };
}

/** "an 8h 35m day" / "a 6h day" — eight, eleven and eighteen take "an". */
function articleFor(duration: string): string {
  return /^(8|11|18)(\D|$)/.test(duration) ? 'an' : 'a';
}

// ── 6. THE DAY — the timeline strip ───────────────────────────────────────────────────
//
// The centrepiece. Focused / at the machine / away, in the capture pipeline's OWN attention
// classification — no new inference, so the strip cannot disagree with the per-task numbers.
//
// THE GAP RULE: an hour with NOTHING recorded renders as empty — no fill, bare track, never as
// away. "Nothing there reads as nothing." There is no fourth legend item; instead, on days that
// actually have a gap, one line goes under the legend. Never explain a thing that is not on the
// page.

type TimelineSegmentKind = 'focus' | 'active' | 'away' | 'gap';
interface TimelineSegment { kind: TimelineSegmentKind; weight: number }

/** Integer percentages that sum to exactly 100 (largest-remainder), so a fixed-layout table
 *  never overflows its 600px. Segments that round to zero are dropped, not rendered at 0%. */
function toPercentWidths(weights: readonly number[]): number[] {
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (w / total) * 100);
  const widths = raw.map((r) => Math.floor(r));
  let left = 100 - widths.reduce((sum, w) => sum + w, 0);
  const byFraction = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (const entry of byFraction) {
    if (left <= 0) break;
    widths[entry.i] = (widths[entry.i] ?? 0) + 1;
    left -= 1;
  }
  return widths;
}

interface TimelineShape {
  segments: TimelineSegment[];
  startHour: number;
  endHour: number;
  hasGap: boolean;
}

/**
 * Turns the payload's hours into one row of proportional segments.
 *
 * Each hour in the span carries equal width, and a recorded hour is split by its OWN recorded
 * seconds rather than against a full 3600. A part-recorded hour (the first and last of the day
 * always are) would otherwise show a bare-track remainder — and bare track means "machine off",
 * which would be a false claim in the middle of a working hour.
 */
function buildTimelineShape(hours: ReadonlyArray<DigestTimelineHour> | undefined): TimelineShape | null {
  const byHour = new Map<number, { focus: number; active: number; away: number }>();
  for (const h of hours ?? []) {
    if (!h || !Number.isInteger(h.hourLocal) || h.hourLocal < 0 || h.hourLocal > 23) continue;
    const focus = Number.isFinite(h.focusSeconds) ? Math.max(0, h.focusSeconds) : 0;
    const active = Number.isFinite(h.activeSeconds) ? Math.max(0, h.activeSeconds) : 0;
    const away = Number.isFinite(h.awaySeconds) ? Math.max(0, h.awaySeconds) : 0;
    // An hour that recorded nothing is a gap, whether it arrived as zeros or never arrived.
    if (focus + active + away <= 0) continue;
    const prev = byHour.get(h.hourLocal);
    byHour.set(h.hourLocal, prev
      ? { focus: prev.focus + focus, active: prev.active + active, away: prev.away + away }
      : { focus, active, away });
  }

  if (byHour.size === 0) return null;

  const present = [...byHour.keys()].sort((a, b) => a - b);
  const startHour = present[0]!;
  const endHour = present[present.length - 1]!;

  const raw: TimelineSegment[] = [];
  let hasGap = false;
  for (let hour = startHour; hour <= endHour; hour++) {
    const rec = byHour.get(hour);
    if (!rec) {
      hasGap = true;
      raw.push({ kind: 'gap', weight: 1 });
      continue;
    }
    const total = rec.focus + rec.active + rec.away;
    if (rec.focus > 0) raw.push({ kind: 'focus', weight: rec.focus / total });
    if (rec.active > 0) raw.push({ kind: 'active', weight: rec.active / total });
    if (rec.away > 0) raw.push({ kind: 'away', weight: rec.away / total });
  }

  // Merge neighbours of the same kind so an unbroken focused stretch renders as one block.
  const segments: TimelineSegment[] = [];
  for (const seg of raw) {
    const last = segments[segments.length - 1];
    if (last && last.kind === seg.kind) last.weight += seg.weight;
    else segments.push({ ...seg });
  }

  return { segments, startHour, endHour, hasGap };
}

const SEGMENT_FILL: Record<TimelineSegmentKind, string | null> = {
  focus: ACCENT,
  active: AT_MACHINE,
  away: AWAY,
  gap: null, // no fill — the bare track shows through
};

/** 8am / 10 / 12 / 2 / 4 / 6pm — the ends carry the suffix, the middles are bare numbers. */
function hourMarkerCells(startHour: number, endHour: number): string {
  const span = endHour - startHour + 1;
  const step = Math.max(1, Math.ceil(span / 6));
  const marks: number[] = [];
  for (let h = startHour; h <= endHour; h += step) marks.push(h);
  if (marks[marks.length - 1] !== endHour) marks.push(endHour);

  return marks
    .map((h, i) => {
      const isFirst = i === 0;
      const isLast = i === marks.length - 1;
      const label = isFirst || isLast ? fmt12h(h) : String(h % 12 || 12);
      const align = isFirst ? 'left' : isLast ? 'right' : 'center';
      return `<td align="${align}" style="font-size:10px;color:${META};">${label}</td>`;
    })
    .join('');
}

function buildTimelineHtml(p: DailyDigestPayload): string {
  const shape = buildTimelineShape(p.dayTimeline);
  // Agents before 1.2.140 send no timeline at all. No data, no section — the rest of the
  // email is unaffected and nothing anywhere refers to a strip that is not there.
  if (!shape) return '';

  const widths = toPercentWidths(shape.segments.map((s) => s.weight));
  const cells = shape.segments
    .map((seg, i) => ({ seg, width: widths[i] ?? 0 }))
    .filter((c) => c.width > 0)
    .map(({ seg, width }) => {
      const fill = SEGMENT_FILL[seg.kind];
      const background = fill === null ? '' : `background:${fill};`;
      return `<td width="${width}%" style="${background}font-size:0;line-height:14px;">&nbsp;</td>`;
    })
    .join('');

  if (cells.length === 0) return '';

  const gapNote = shape.hasGap
    ? `
  ${spacer(7)}
  <div style="font-size:11px;color:${META};">Gaps are hours your machine was off.</div>`
    : '';

  return `
<!-- 6 THE DAY -->
<tr><td style="padding:20px 32px 0 32px;">
  <div style="${LABEL_STYLE}">The day</div>
  ${spacer(12)}

  <!-- Track sits UNDER the fills. An hour with nothing recorded gets no fill at all, so the bare
       track shows through: nothing there reads as nothing, and never as away. -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;table-layout:fixed;background:${GAP_TRACK};border-radius:3px;overflow:hidden;">
    <tr style="height:14px;">${cells}</tr>
  </table>

  ${spacer(7)}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;table-layout:fixed;">
    <tr>${hourMarkerCells(shape.startHour, shape.endHour)}</tr>
  </table>

  ${spacer(12)}
  <div style="font-size:11px;color:${META};">
    <span style="display:inline-block;width:8px;height:8px;background:${ACCENT};border-radius:2px;"></span>&nbsp;Focused &nbsp;&nbsp;
    <span style="display:inline-block;width:8px;height:8px;background:${AT_MACHINE};border-radius:2px;"></span>&nbsp;At the machine &nbsp;&nbsp;
    <span style="display:inline-block;width:8px;height:8px;background:${AWAY};border:0.5px solid ${AWAY_EDGE};border-radius:2px;"></span>&nbsp;Away
  </div>${gapNote}
</td></tr>
${ruleRow()}`;
}

// ── 7. Tasks ──────────────────────────────────────────────────────────────────────────
//
// One block each: title, bar, actual time large, planned small beneath. Finished gets the accent
// and a check. ANYTHING MOVED READS "moved on" — never as a failure, never the accent.

function taskBlockHtml(t: DigestTaskEntry): string {
  const done = t.state === 'done';
  const moved = !done && (t.deferredUntilDay ?? '').trim().length > 0;

  const ratio = t.plannedSeconds > 0 ? t.actualSeconds / t.plannedSeconds : 0;
  let fill = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  // The card's 2px floor, in a 220px bar: time that was measured must be visible.
  if (t.actualSeconds > 0 && fill < 2) fill = 2;

  const fillColour = done ? ACCENT : AT_MACHINE;
  const titleColour = done ? BODY : MUTED;
  const actualColour = done ? HEADLINE : MUTED;
  const check = done ? `<span style="color:${ACCENT};">&#10003;</span>&nbsp; ` : '';
  const movedLine = moved
    ? `${spacer(4)}
        <div style="font-size:11px;color:${META};">moved on</div>`
    : '';

  const barCells = fill >= 100
    ? `<td width="100%" style="background:${fillColour};font-size:0;line-height:5px;">&nbsp;</td>`
    : `<td width="${fill}%" style="background:${fillColour};font-size:0;line-height:5px;">&nbsp;</td><td width="${100 - fill}%" style="background:${AWAY};font-size:0;line-height:5px;">&nbsp;</td>`;

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td style="vertical-align:top;">
        <div style="font-size:13px;color:${titleColour};">${check}${escapeHtml(t.title)}</div>${movedLine}
        ${spacer(moved ? 6 : 8)}
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:220px;table-layout:fixed;border-radius:3px;overflow:hidden;">
          <tr style="height:5px;">${barCells}</tr>
        </table>
      </td>
      <td align="right" style="vertical-align:top;white-space:nowrap;">
        <div style="font-size:17px;color:${actualColour};font-variant-numeric:tabular-nums;">${fmtMinutes(t.actualSeconds)}</div>
        ${spacer(3)}
        <div style="font-size:11px;color:${META};font-variant-numeric:tabular-nums;">planned ${fmtMinutes(t.plannedSeconds)}</div>
      </td>
    </tr>
  </table>`;
}

function buildTasksHtml(tasks: ReadonlyArray<DigestTaskEntry>): string {
  if (tasks.length === 0) return '';
  return `
<!-- 7 tasks -->
<tr><td style="padding:20px 32px 0 32px;">
  <div style="${LABEL_STYLE}">Your tasks</div>
  ${spacer(14)}
  ${tasks.map(taskBlockHtml).join(`\n  ${spacer(18)}\n`)}
</td></tr>
${ruleRow()}`;
}

// ── 8. The four figures ───────────────────────────────────────────────────────────────
// Worked · Focused · Best run · Away. "Away" replaces the old "Breaks 0/6" and carries the
// locked/away-not-counted meaning without needing the extra sentence underneath.

function figureCell(label: string, value: string): string {
  return `<td style="vertical-align:top;"><div style="${LABEL_STYLE}">${label}</div>${spacer(5)}<div style="font-size:17px;color:${HEADLINE};font-variant-numeric:tabular-nums;">${value}</div></td>`;
}

function buildFiguresHtml(p: DailyDigestPayload, missing: Set<DigestMissingField>): string {
  const bestRun = missing.has('streak') ? NO_DATA_HTML : fmtMinutes(p.longestFocusStreakSeconds);
  return `
<!-- 8 four figures -->
<tr><td style="padding:20px 32px 0 32px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;table-layout:fixed;">
    <tr>
      ${figureCell('Worked', fmtMinutes(p.trackedSeconds))}
      ${figureCell('Focused', fmtMinutes(p.focusSeconds))}
      ${figureCell('Best run', bestRun)}
      ${figureCell('Away', fmtMinutes(p.awaySeconds))}
    </tr>
  </table>
</td></tr>
${ruleRow()}`;
}

// ── 9 & 10. Where your time went · What pulled you off ────────────────────────────────
//
// UNRECOGNISED TIME IS NOT SHOWN. No "Other browsing", no "Unnamed". §9 is a RANKING of top
// sites, not an accounting of every minute — it never claimed to add up, and the honest totals
// live in the four figures above.

interface DigestApp { label: string; seconds: number; category?: number }

/** True for the residue buckets. `web` is what older agents stored for an unrecognised page;
 *  RESIDUAL_BROWSING_LABEL is what newer ones send; `Unnamed` is unlabelled dwell. */
function isResidueLabel(label: string): boolean {
  const l = label.trim().toLowerCase();
  return l === 'web' || l === RESIDUAL_BROWSING_LABEL.toLowerCase() || l === 'unnamed';
}

function namedApps(p: DailyDigestPayload): DigestApp[] {
  return (p.topApps ?? []).filter(
    (a): a is DigestApp =>
      !!a && typeof a.label === 'string' && a.label.trim().length > 0
      && Number.isFinite(a.seconds) && a.seconds > 0
      && !isResidueLabel(a.label)
  );
}

function buildTopSitesHtml(p: DailyDigestPayload): string {
  const apps = namedApps(p).slice(0, 6);
  if (apps.length === 0) return '';

  const top = Math.max(...apps.map((a) => a.seconds));
  const rows = apps
    .map((a, i) => {
      const last = i === apps.length - 1;
      const pad = last ? '' : 'padding-bottom:10px;';
      const width = Math.max(1, Math.round((a.seconds / top) * 100));
      const bar = width >= 100
        ? `<tr style="height:5px;"><td width="100%" style="background:${AT_MACHINE};font-size:0;line-height:5px;">&nbsp;</td></tr>`
        : `<tr style="height:5px;"><td width="${width}%" style="background:${AT_MACHINE};font-size:0;line-height:5px;">&nbsp;</td><td width="${100 - width}%" style="background:${AWAY};font-size:0;line-height:5px;">&nbsp;</td></tr>`;
      return `    <tr>
      <td${i === 0 ? ' width="130"' : ''} style="font-size:12px;color:${BODY};${pad}">${escapeHtml(a.label)}</td>
      <td style="${pad}">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;border-radius:3px;overflow:hidden;">
          ${bar}
        </table>
      </td>
      <td${i === 0 ? ' width="62"' : ''} align="right" style="font-size:12px;color:${BODY};font-variant-numeric:tabular-nums;${pad}">${fmtMinutes(a.seconds)}</td>
    </tr>`;
    })
    .join('\n');

  return `
<!-- 9 where your time went -->
<tr><td style="padding:20px 32px 0 32px;">
  <div style="${LABEL_STYLE}">Where your time went</div>
  ${spacer(14)}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${rows}
  </table>
</td></tr>
${ruleRow()}`;
}

// Coarse distraction categories: 1=Entertainment, 3=SocialMedia, 4=Gaming, 7=GamingLauncher.
const DISTRACTING_CATEGORIES = new Set([1, 3, 4, 7]);

function buildPulledOffHtml(p: DailyDigestPayload): string {
  // ONLY rows with real numbers. Never "no data", never zeros. Nothing to show → the whole
  // section, its label included, is omitted.
  const apps = namedApps(p)
    .filter((a) => DISTRACTING_CATEGORIES.has(a.category ?? 0))
    .slice(0, 5);
  if (apps.length === 0) return '';

  const rows = apps
    .map((a, i) => {
      const pad = i === apps.length - 1 ? '' : 'padding-bottom:8px;';
      return `    <tr>
      <td style="font-size:12px;color:${BODY};${pad}">${escapeHtml(a.label)}</td>
      <td align="right" style="font-size:12px;color:${BODY};font-variant-numeric:tabular-nums;${pad}">${fmtMinutes(a.seconds)}</td>
    </tr>`;
    })
    .join('\n');

  return `
<!-- 10 what pulled you off -->
<tr><td style="padding:20px 32px 0 32px;">
  <div style="${LABEL_STYLE}">What pulled you off</div>
  ${spacer(14)}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${rows}
  </table>
</td></tr>
${ruleRow()}`;
}

// ── 11. Ari's take ────────────────────────────────────────────────────────────────────
//
// In serif, so it reads as someone talking rather than another data row. Built from ACTUAL TASK
// OUTCOMES, never inference — and when it cannot see an outcome it says so rather than fill the
// space with something that would be true of any day.

export const NO_OUTCOME_LINE =
  "Ari can't see how any task ended today, so there's nothing here it will guess at.";

function buildAriTakeHtml(body: string): string {
  return `
<!-- 11 Ari's take -->
<tr><td style="padding:20px 32px 0 32px;">
  <div style="${LABEL_STYLE}">Ari's take</div>
  ${spacer(10)}
  <div style="font-family:${SERIF};font-size:15px;line-height:1.6;color:${BODY};">
    ${escapeHtml(body).replace(/\n/g, '<br>')}
  </div>
</td></tr>`;
}

// ── Main builder ──────────────────────────────────────────────────────────────────────

export async function buildDigestEmail(
  p: DailyDigestPayload,
  launchUrl = 'porta://open',
  h: UserHistory | null = null,
  firstName: string | null = null
): Promise<{ subject: string; html: string }> {
  const missing = resolveMissingFields(p);

  // Format date nicely: "Tuesday, 11 August 2026"
  let dateDisplay = p.dateLocal;
  try {
    const d = new Date(p.dateLocal + 'T00:00:00');
    dateDisplay = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    /* keep raw string */
  }

  // Subject line is unchanged by the redesign — the streak subject ("9 days in a row") stays.
  const todayFocusPct = p.trackedSeconds > 0 ? Math.round((p.focusSeconds / p.trackedSeconds) * 100) : 0;
  const todayFocusScore = Math.round(p.focusQualityScore * 100);
  const todayIsPersonalBest = h != null && h.daysOfData >= 5 && (
    todayFocusScore > h.bestFocusScore ||
    (!missing.has('streak') && p.longestFocusStreakSeconds / 60 > h.bestStreakMin) ||
    todayFocusPct > h.bestFocusPct
  );
  const subject = buildSubjectLine(p, h, todayIsPersonalBest, dateDisplay);

  // 4 — the offline notice, ONLY when it applies. The cut-off time is not a number we hold, so
  // it is described rather than invented.
  const offlineHtml = p.isServerFallback
    ? `
<!-- 4 offline notice (conditional) -->
<tr><td style="padding:16px 32px 0 32px;">
  <div style="border-left:2px solid ${HAIRLINE};padding:2px 0 2px 10px;font-size:11px;color:${META};line-height:1.5;">
    Your machine was offline at send time, so this covers the day only up to its last report.
  </div>
</td></tr>`
    : '';

  // 5 — the headline. Two lines from the board, then one line of context.
  const tasks = (p.tasks ?? []).filter(
    (t): t is DigestTaskEntry =>
      !!t && typeof t.title === 'string' && t.title.trim().length > 0
      && Number.isFinite(t.plannedSeconds) && t.plannedSeconds > 0
      && Number.isFinite(t.actualSeconds) && t.actualSeconds >= 0
  ).slice(0, 8);

  const summary = summarizeDay(tasks);
  const workedLabel = fmtMinutes(p.trackedSeconds);
  const contextLine = `${fmtMinutes(p.focusSeconds)} focused across ${articleFor(workedLabel)} ${workedLabel} day.`;
  const headlineHtml = `
<!-- 5 headline -->
<tr><td style="padding:24px 32px 0 32px;">${summary === null ? '' : `
  <div style="font-size:20px;line-height:1.35;color:${HEADLINE};font-weight:400;">
    ${escapeHtml(summary.planned)}<br>${escapeHtml(summary.finished)}
  </div>
  ${spacer(8)}`}
  <div style="font-size:12px;color:${MUTED};line-height:1.5;">${contextLine}</div>
</td></tr>
${ruleRow(24)}`;

  // 11 — Ari's take. With no outcome on the board there is nothing to write FROM, so the honest
  // line goes in without troubling the model. With outcomes, buildAriTake writes from them and
  // never throws: on any failure it returns null and the section is OMITTED — never a fallback
  // to the old generic streak line.
  const hasOutcome = tasks.some((t) => t.state === 'done' || (t.deferredUntilDay ?? '').trim().length > 0);
  const takeBody = hasOutcome ? await buildAriTake(p) : NO_OUTCOME_LINE;
  const ariTakeHtml = takeBody === null ? '' : buildAriTakeHtml(takeBody);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>Ari Daily Digest</title>
</head>
<body style="margin:0;padding:0;background:${PAGE_BG};">
<div style="margin:0;padding:0;background:${PAGE_BG};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE_BG};padding:32px 0;">
<tr><td align="center">

<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:${CARD_BG};border:0.5px solid ${HAIRLINE};border-radius:12px;font-family:${SANS};">

<!-- 1 wordmark / 2 label / 3 date -->
<tr><td style="padding:28px 32px 0 32px;">
  <div style="font-size:15px;font-weight:500;color:${HEADLINE};letter-spacing:-0.1px;">Ari <span style="color:${META};font-weight:400;">by Porta</span></div>
  ${spacer(18)}
  <div style="${LABEL_STYLE}">Your day at a glance</div>
  ${spacer(6)}
  <div style="font-size:13px;color:${MUTED};">${escapeHtml(dateDisplay)}</div>
</td></tr>
${offlineHtml}
${headlineHtml}
${buildTimelineHtml(p)}
${buildTasksHtml(tasks)}
${buildFiguresHtml(p, missing)}
${buildTopSitesHtml(p)}
${buildPulledOffHtml(p)}
${ariTakeHtml}
<!-- 12 button -->
<tr><td style="padding:26px 32px 0 32px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td align="center" style="background:${ACCENT};border-radius:7px;">
      <a href="${launchUrl}" style="display:block;padding:11px 0;font-size:13px;color:${ACCENT_TEXT};text-decoration:none;font-weight:500;font-family:${SANS};">Open Ari</a>
    </td></tr>
  </table>
</td></tr>

<!-- 13 footer -->
<tr><td style="padding:22px 32px 28px 32px;">
  <div style="font-size:11px;color:${META};">Sent by Ari &middot; <a href="https://useporta.com" style="color:${META};text-decoration:none;">useporta.com</a></div>
</td></tr>

</table>
</td></tr>
</table>
</div>
</body>
</html>`;

  return { subject, html };
}
