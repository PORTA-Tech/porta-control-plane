import Anthropic from '@anthropic-ai/sdk';
import { getUserHistory } from '../store/userHistoryStore.js';
import { getDailyStatsForAccount } from '../store/dailyStatsStore.js';

/**
 * Part 5 — live check-in copy. The digest already proved the pattern (digestNarrative.buildAriTake):
 * server-side Opus, a fact sheet of MEASURED values only, and a locked fail-soft contract. This
 * service generalizes it to the live moments: morning / midday / end-of-day check-in lines and a
 * short response to what the user actually typed.
 *
 * Contracts carried over unchanged:
 * - Grounding: every sentence must trace to a fact we pass. Absent facts are omitted, never zeroed.
 * - Fail-soft: any failure (no key, timeout, refusal, unusable reply, rate cap) returns null and
 *   the AGENT renders its short honest template. Never a generic filler line, never a blocked card.
 * - One call per high-value moment: check-in lines are cached per account+kind+local-day, so
 *   retries and poll races cannot double-bill. Typed replies are inherently per-utterance and are
 *   not cached, but count against the same daily per-account cap.
 */

const MODEL = 'claude-opus-4-8';
const REQUEST_TIMEOUT_MS = 8_000; // the agent's card budget is short; a slow reply is a dead reply
const MAX_TOKENS = 250;

/** Hard per-account daily ceiling across ALL narrative calls (3 check-ins + replies + slack). */
export const NARRATIVE_DAILY_CALL_CAP = 16;

export type NarrativeKind =
  | 'morning'
  | 'midday'
  | 'eod'
  | 'reply_morning'
  | 'reply_midday'
  | 'reply_eod';

export const NARRATIVE_KINDS: readonly NarrativeKind[] = [
  'morning', 'midday', 'eod', 'reply_morning', 'reply_midday', 'reply_eod',
];

/** The agent-assembled situation. Numbers and short labels only — same privacy bar as the digest. */
export interface NarrativeSituation {
  goalToday?: string | null;
  carriedPlan?: string | null;   // last night's plan surfaced by the morning card (Part 3)
  middayAnswer?: string | null;  // yes | partly | not_yet
  trackedSeconds?: number;
  focusSeconds?: number;         // focus-episode time (Part 1)
  focusQualityPct?: number;
  distractionSeconds?: number;
  awaySeconds?: number;
  longestStreakSeconds?: number;
  topApps?: { label: string; seconds: number }[];
  localTimeHHmm?: string;
  userText?: string | null;      // the typed reply — reply_* kinds only
  middaySkipped?: boolean;       // eod (Part 1b): a morning goal was set but midday was never answered
  awayGap?: boolean;             // eod (Part 1b): a substantial away stretch today
}

const SYSTEM_PROMPT = [
  'You are Ari, a focus assistant, speaking in a small desktop check-in card.',
  '',
  'Rules:',
  '- Output ONLY the line itself: no preamble, no sign-off, no bullets, no markdown, no emoji.',
  '- Every claim must trace to a fact you were given. Never invent, estimate, or extrapolate a',
  '  number. If you were not given something, do not mention it.',
  '- Be specific to THIS person and THIS moment. Never write a line that would be true of any day.',
  '- Plain and honest, colleague tone. No hype, no lecturing, no guilt. If the day is going badly,',
  '  say so without judgement.',
  '- Address the reader as "you".',
].join('\n');

// Exported for tests — the per-kind instruction the model gets. midday/eod must END with the actual
// question (Part 2a) so the card's answer controls are never orphaned.
export const KIND_INSTRUCTION: Record<NarrativeKind, string> = {
  morning: [
    'Write 1-2 short sentences to open the morning check-in. Frame the day around the goal or',
    'carried-over plan if one is given; reference yesterday\'s outcome when provided. End in a way',
    'that invites them to state or confirm today\'s goal.',
  ].join('\n'),
  midday: [
    'Write one or two short sentences for the midday check-in: read the stated goal against the real',
    'numbers so far, then end by asking whether they got to it — e.g. "did you get to it?". The card',
    'shows Yes / Partly / Not-yet buttons under your line, so your last sentence must be that question.',
  ].join('\n'),
  eod: [
    'Write one or two short sentences to close the day: an honest reflection on how the day went',
    'against the goal (if given). If the midday check-in was skipped or they were away a while, frame',
    'it as ONE whole-day wrap that acknowledges the gap rather than treating it as a full work day.',
    'End by asking: what is the one thing for tomorrow? The card shows a plan text box under your',
    'line, so your last sentence must be that question.',
  ].join('\n'),
  reply_morning: [
    'The user just typed their goal for today (given as their reply). Respond with ONE short',
    'sentence acknowledging that specific goal and how you will help protect it. No questions.',
  ].join('\n'),
  reply_midday: [
    'The user just answered the midday progress question (their answer is given). Respond with ONE',
    'short supportive, non-generic sentence grounded in their answer and the day\'s numbers.',
  ].join('\n'),
  reply_eod: [
    'The user just typed their plan for tomorrow (given as their reply). Respond with ONE short',
    'sentence confirming you will bring that plan up tomorrow morning. No questions.',
  ].join('\n'),
};

function humanDuration(seconds: number): string {
  const mins = Math.round(Math.max(0, seconds) / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

const MIDDAY_LABEL: Record<string, string> = {
  yes: 'yes, they were getting to it',
  partly: 'partly',
  not_yet: 'no, not yet',
};

/** Server-side enrichment: yesterday's goal/outcome + long-run patterns. Failures yield {}. */
export interface NarrativeEnrichment {
  yesterdayGoal?: string | null;
  yesterdayMiddayAnswer?: string | null;
  yesterdayFocusSeconds?: number;
  yesterdayTrackedSeconds?: number;
  daysOfData?: number;
  focusTrend?: string;
  weakHour?: number | null;
  strongWindowStart?: number | null;
}

export async function loadEnrichment(accountId: string, dateLocal: string): Promise<NarrativeEnrichment> {
  try {
    const [history, stats] = await Promise.all([
      getUserHistory(accountId),
      getDailyStatsForAccount(accountId, 8),
    ]);

    const yesterday = stats
      .filter((s) => s.dateLocal < dateLocal)
      .sort((a, b) => b.dateLocal.localeCompare(a.dateLocal))[0];

    const enrichment: NarrativeEnrichment = {};
    if (yesterday) {
      enrichment.yesterdayGoal = yesterday.goal ?? null;
      enrichment.yesterdayMiddayAnswer = yesterday.middayAnswer ?? null;
      enrichment.yesterdayFocusSeconds = yesterday.focusSeconds;
      enrichment.yesterdayTrackedSeconds = yesterday.trackedSeconds;
    }

    // Patterns only once there is enough data for them to mean anything.
    if (history && history.daysOfData >= 5) {
      enrichment.daysOfData = history.daysOfData;
      enrichment.focusTrend = history.focusTrend;
      enrichment.weakHour = history.weakHour;
      enrichment.strongWindowStart = history.strongWindowStart;
    }

    return enrichment;
  } catch {
    return {};
  }
}

/**
 * The fact sheet handed to the model. Only measured/stated values; absent things are omitted so
 * the model can never narrate a fabricated figure. Exported for tests.
 */
export function buildSituationFacts(
  kind: NarrativeKind,
  situation: NarrativeSituation,
  enrichment: NarrativeEnrichment
): string {
  const lines: string[] = [];

  if (situation.localTimeHHmm) lines.push(`Local time: ${situation.localTimeHHmm}`);

  const goal = (situation.goalToday ?? '').trim();
  if (goal) lines.push(`Today's stated goal: "${goal}"`);

  const carried = (situation.carriedPlan ?? '').trim();
  if (carried && !goal) lines.push(`Last night they planned for today: "${carried}" (not yet confirmed this morning)`);

  const midday = (situation.middayAnswer ?? '').trim();
  if (midday && MIDDAY_LABEL[midday]) lines.push(`Midday answer on whether they were getting to the goal: ${MIDDAY_LABEL[midday]}`);

  if (typeof situation.trackedSeconds === 'number' && situation.trackedSeconds > 0) {
    lines.push(`Time tracked at the computer so far today: ${humanDuration(situation.trackedSeconds)}`);
  }
  if (typeof situation.focusSeconds === 'number' && situation.focusSeconds > 0) {
    lines.push(`Of that, focused: ${humanDuration(situation.focusSeconds)}`);
  }
  if (typeof situation.focusQualityPct === 'number' && situation.focusQualityPct > 0) {
    lines.push(`Focus quality so far: ${Math.round(situation.focusQualityPct)}%`);
  }
  if (typeof situation.distractionSeconds === 'number' && situation.distractionSeconds > 0) {
    lines.push(`Time on distracting apps/sites so far: ${humanDuration(situation.distractionSeconds)}`);
  }
  if (typeof situation.awaySeconds === 'number' && situation.awaySeconds > 0) {
    lines.push(`Away from the computer so far: ${humanDuration(situation.awaySeconds)}`);
  }
  if (typeof situation.longestStreakSeconds === 'number' && situation.longestStreakSeconds > 0) {
    lines.push(`Longest unbroken focus run today: ${humanDuration(situation.longestStreakSeconds)}`);
  }

  const apps = situation.topApps ?? [];
  if (apps.length > 0) {
    const top = apps.slice(0, 3).map((a) => `${a.label} ${humanDuration(a.seconds)}`).join(', ');
    lines.push(`Where the time went so far: ${top}`);
  }

  // Part 1b — the EOD whole-day facts. Only meaningful when closing the day, so scoped to 'eod'.
  if (kind === 'eod') {
    if (situation.middaySkipped) {
      lines.push('A morning goal was set, but the midday check-in was never answered today.');
    }
    if (situation.awayGap) {
      lines.push('They were away from the computer for a substantial stretch today.');
    }
  }

  if (enrichment.yesterdayGoal) {
    lines.push(`Yesterday's goal was: "${enrichment.yesterdayGoal}"`);
    const ans = (enrichment.yesterdayMiddayAnswer ?? '').trim();
    if (ans && MIDDAY_LABEL[ans]) lines.push(`Yesterday at midday they said they were getting to it: ${MIDDAY_LABEL[ans]}`);
  }
  if (typeof enrichment.yesterdayFocusSeconds === 'number' && enrichment.yesterdayFocusSeconds > 0) {
    lines.push(`Yesterday's focused time: ${humanDuration(enrichment.yesterdayFocusSeconds)}`);
  }
  if (enrichment.daysOfData) {
    lines.push(`Days of history: ${enrichment.daysOfData}; focus trend: ${enrichment.focusTrend ?? 'unknown'}`);
    if (typeof enrichment.weakHour === 'number' && enrichment.weakHour >= 0) {
      lines.push(`Their usual weak hour: ${String(enrichment.weakHour).padStart(2, '0')}:00`);
    }
    if (typeof enrichment.strongWindowStart === 'number' && enrichment.strongWindowStart >= 0) {
      lines.push(`Their usual strong window starts: ${String(enrichment.strongWindowStart).padStart(2, '0')}:00`);
    }
  }

  const typed = (situation.userText ?? '').trim();
  if (kind.startsWith('reply_') && typed) {
    lines.push(`Their reply just now: "${typed}"`);
  }

  return lines.join('\n');
}

/** Lines render in a small card; anything outside these bounds reads broken. */
function isUsable(text: string): boolean {
  const t = text.trim();
  return t.length >= 10 && t.length <= 420;
}

// ── one-call-per-moment bookkeeping ─────────────────────────────────────────────────────────────

const lineCache = new Map<string, { line: string; storedAtMs: number }>();
const dailyCallCount = new Map<string, { count: number; storedAtMs: number }>();
const STALE_MS = 48 * 60 * 60 * 1000;

function sweep(map: Map<string, { storedAtMs: number }>, nowMs: number): void {
  for (const [key, value] of map) {
    if (nowMs - value.storedAtMs > STALE_MS) map.delete(key);
  }
}

function cacheKey(accountId: string, kind: NarrativeKind, dateLocal: string): string {
  return `${accountId}:${kind}:${dateLocal}`;
}

/** Exported for tests. Counts a call attempt; false = the daily cap is exhausted. */
export function tryConsumeCallBudget(accountId: string, dateLocal: string, nowMs = Date.now()): boolean {
  sweep(dailyCallCount, nowMs);
  const key = `${accountId}:${dateLocal}`;
  const entry = dailyCallCount.get(key) ?? { count: 0, storedAtMs: nowMs };
  if (entry.count >= NARRATIVE_DAILY_CALL_CAP) return false;
  entry.count += 1;
  entry.storedAtMs = nowMs;
  dailyCallCount.set(key, entry);
  return true;
}

/** Test hook — narrative state is in-memory and must not leak across tests. */
export function resetNarrativeStateForTests(): void {
  lineCache.clear();
  dailyCallCount.clear();
}

/**
 * Returns the line for this moment, or null when the agent should use its template. Never throws.
 * `client` is injectable for tests.
 */
export async function buildNarrativeLine(
  accountId: string,
  dateLocal: string,
  kind: NarrativeKind,
  situation: NarrativeSituation,
  client?: Anthropic
): Promise<string | null> {
  const nowMs = Date.now();
  sweep(lineCache, nowMs);

  // Check-in lines are one-per-moment-per-day: a cached line is the SAME moment re-requested
  // (agent retry, poll race), so return it without a new model call. Replies are per-utterance.
  const cacheable = !kind.startsWith('reply_');
  const key = cacheKey(accountId, kind, dateLocal);
  if (cacheable) {
    const cached = lineCache.get(key);
    if (cached) return cached.line;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!client && !apiKey) {
    console.warn('[narrative] ANTHROPIC_API_KEY not set — agent will use its template.');
    return null;
  }

  if (!tryConsumeCallBudget(accountId, dateLocal, nowMs)) {
    console.warn(`[narrative] Daily call cap reached for account ${accountId} (${dateLocal}).`);
    return null;
  }

  const enrichment = await loadEnrichment(accountId, dateLocal);
  const facts = buildSituationFacts(kind, situation, enrichment);
  const anthropic = client ?? new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS });

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: `${SYSTEM_PROMPT}\n\n${KIND_INSTRUCTION[kind]}`,
      messages: [
        {
          role: 'user',
          content: `Here is everything measured or stated. Write the line.\n\n${facts}`,
        },
      ],
    });

    if (message.stop_reason === 'refusal') {
      console.warn('[narrative] Model declined — agent will use its template.');
      return null;
    }

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    if (!isUsable(text)) {
      console.warn(`[narrative] Unusable reply (${text.length} chars) — agent will use its template.`);
      return null;
    }

    if (cacheable) {
      lineCache.set(key, { line: text, storedAtMs: nowMs });
    }

    return text;
  } catch (err) {
    console.error('[narrative] Model call failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}
