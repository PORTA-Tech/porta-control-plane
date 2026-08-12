import Anthropic from '@anthropic-ai/sdk';
import type { DailyDigestPayload } from './digestEmailBuilder.js';

/**
 * C2 / C-decision — "Ari's take": the digest's closing narrative, written by an LLM from THAT
 * DAY's real numbers plus the user's stated goal and midday answer.
 *
 * Why an LLM and not a template: the digest previously closed with one recurring line ("N days in
 * a row with focus above X% — don't break the chain"), which is the exact "generic / sounds like a
 * scam" failure this replaces. A template pool cannot stay specific and non-repeating across
 * months of daily sends; a model writing from the day's actual figures can.
 *
 * Grounding rule (Trust_And_Value_FixPlan W5): every sentence must trace to a real number we
 * measured. The prompt below passes ONLY measured values, and instructs against inventing any.
 *
 * Failure contract (locked in the plan): if the call fails, is not configured, or returns
 * something unusable, return null — the caller then OMITS the section. Never fall back to the
 * generic streak line.
 */

// The user named no model, so this is the current default per the Claude API guidance. One call
// per user per day makes the cost negligible, and the writing quality IS the feature here.
const MODEL = 'claude-opus-4-8';
const REQUEST_TIMEOUT_MS = 20_000;
// "Ari's take" is 2-4 sentences by design — a deliberately short output, so a small cap is right.
const MAX_TOKENS = 400;

const SYSTEM_PROMPT = [
  'You write one short paragraph ("Ari\'s take") at the end of a daily focus digest email.',
  '',
  'Rules:',
  '- 2 to 4 sentences. No preamble, no sign-off, no bullet points, no markdown, no emoji.',
  '- Output ONLY the paragraph itself. Do not explain your reasoning or restate the task.',
  '- Every claim must trace to a number or fact you were given. Never invent, estimate, or',
  '  extrapolate a number. If you were not given something, do not mention it.',
  '- Be specific to THIS day. Never write a generic line that would be true of any day.',
  '- Be honest and plain. Do not flatter, moralize, or lecture. If the day went badly, say so',
  '  without judgement. If it went well, say that plainly without hype.',
  '- Address the reader as "you". Refer to yourself as "I" only if it is natural; usually do not.',
  '- If a goal is given, the paragraph should speak to how the day went against THAT goal.',
  '- Task outcomes are the subject. Write about what happened to the tasks — what finished, what',
  '  took longer or less than planned, what moved on. The day\'s totals are context, not the story.',
  '- A task that moved to another day has MOVED ON. Never call it a failure, a miss, or a slip.',
].join('\n');

/** Formats seconds as "2h 30m" / "45m" — the same shape the email's stat row uses. */
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

/**
 * Builds the fact sheet handed to the model. ONLY measured values go in — anything absent is
 * simply omitted rather than sent as a zero, so the model can never narrate a fabricated figure.
 */
export function buildNarrativeFacts(payload: DailyDigestPayload): string {
  const lines: string[] = [];

  const goal = (payload.goal ?? '').trim();
  if (goal.length > 0) {
    lines.push(`Their stated goal this morning: "${goal}"`);
    const answer = (payload.middayAnswer ?? '').trim();
    if (answer && MIDDAY_LABEL[answer]) {
      lines.push(`At midday, asked if they were getting to it, they said: ${MIDDAY_LABEL[answer]}.`);
    }
  } else {
    lines.push('They did not set a goal today.');
  }

  // The 2026-08-11 redesign makes ARI'S TAKE a statement about the task board, so the outcomes
  // lead the fact sheet. Each line is measured: the state came from what the user ticked, the
  // seconds from the capture pipeline. The caller does not even ask for a take when the board
  // shows no outcome, so the model is never left to fill the space from the totals alone.
  const tasks = payload.tasks ?? [];
  if (tasks.length > 0) {
    lines.push(`Their task board today (${tasks.length} task${tasks.length === 1 ? '' : 's'} planned):`);
    for (const t of tasks) {
      const movedTo = (t.deferredUntilDay ?? '').trim();
      const outcome = t.state === 'done'
        ? 'finished'
        : movedTo.length > 0
          ? `not finished, moved on to ${movedTo}`
          : t.state === 'abandoned'
            ? 'dropped'
            : 'still open';
      lines.push(
        `- "${t.title}": ${outcome}. Planned ${humanDuration(t.plannedSeconds)}, `
        + `actually worked ${humanDuration(t.actualSeconds)}.`
      );
    }
  } else {
    lines.push('They planned no tasks today.');
  }

  lines.push(`Time tracked at the computer: ${humanDuration(payload.trackedSeconds)}`);
  lines.push(`Of that, focused: ${humanDuration(payload.focusSeconds)}`);
  if (payload.longestFocusStreakSeconds > 0) {
    lines.push(`Longest unbroken focus run: ${humanDuration(payload.longestFocusStreakSeconds)}`);
  }
  if (payload.distractionSeconds > 0) {
    lines.push(`Time on distracting apps/sites: ${humanDuration(payload.distractionSeconds)}`);
  }
  if (payload.awaySeconds > 0) {
    lines.push(`Away from the computer / screen locked: ${humanDuration(payload.awaySeconds)}`);
  }

  const breaksSuggested = payload.breaksSuggestedCount;
  if (breaksSuggested > 0) {
    lines.push(`Breaks Ari suggested: ${breaksSuggested}; breaks actually taken: ${payload.breaksTakenCount}`);
  }

  const apps = payload.topApps ?? [];
  if (apps.length > 0) {
    const top = apps
      .slice(0, 5)
      .map((a) => `${a.label} ${humanDuration(a.seconds)}`)
      .join(', ');
    lines.push(`Where the time actually went: ${top}`);
  }

  return lines.join('\n');
}

/** True when a model reply is usable as the section body. */
function isUsable(text: string): boolean {
  const t = text.trim();
  return t.length >= 20 && t.length <= 1200;
}

/**
 * Returns the narrative paragraph, or null when it should be omitted. Never throws — a digest must
 * still send if the model call fails. `client` is injectable for tests.
 */
export async function buildAriTake(
  payload: DailyDigestPayload,
  client?: Anthropic
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!client && !apiKey) {
    console.warn('[digest-narrative] ANTHROPIC_API_KEY not set — omitting Ari\'s take.');
    return null;
  }

  const anthropic = client ?? new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS });
  const facts = buildNarrativeFacts(payload);

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Here is everything measured about this person's day. Write Ari's take.\n\n${facts}`,
        },
      ],
    });

    // stop_reason must be checked before reading content — a refusal returns 200 with no text.
    if (message.stop_reason === 'refusal') {
      console.warn('[digest-narrative] Model declined — omitting Ari\'s take.');
      return null;
    }

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    if (!isUsable(text)) {
      console.warn(`[digest-narrative] Unusable reply (${text.length} chars) — omitting Ari's take.`);
      return null;
    }

    return text;
  } catch (err) {
    // Fail soft and loud in the log: the digest still goes out, just without this section.
    console.error(
      '[digest-narrative] Failed to build Ari\'s take:',
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}
