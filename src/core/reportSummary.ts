import Anthropic from '@anthropic-ai/sdk';

/**
 * Phase 1.4 (2026-08-17) — Ari drafts the report's summary paragraph.
 *
 * THE RULE THAT MAKES THE REPORT CREDIBLE, and it is enforced by what is in the request rather
 * than by asking the model nicely: the only things sent here are the client-facing project name
 * and, per task, the client-facing label, status, hours and the one-line result the USER wrote.
 * No raw task titles, no app usage, no focus, no pressure, no distraction, no activity data of
 * any kind. Ari cannot invent an accomplishment from app usage because app usage never arrives.
 *
 * A prompt instruction saying "don't use activity data" would be a promise. Omitting the data is
 * a property. `toSummaryFacts` below is the whole boundary — it builds the model's input from a
 * fixed field list and ignores everything else on the object, so a future field added upstream
 * cannot leak into this call by being carried along.
 *
 * The draft is a DRAFT. The user edits or replaces it and nothing sends unapproved.
 */

const MODEL = 'claude-opus-5';
const MAX_TOKENS = 700;
const REQUEST_TIMEOUT_MS = 30_000;

/** The four-way status the report reads in. Anything else is rejected upstream. */
export type TaskStatus = 'planned' | 'in_progress' | 'done' | 'blocked';

export interface SummaryTask {
  clientLabel: string;
  status: TaskStatus;
  hours: number;
  result: string;
  blockedReason?: string;
}

export interface SummaryRequest {
  projectName: string;
  rangeStartLocal: string;
  rangeEndLocal: string;
  tasks: SummaryTask[];
}

const SYSTEM_PROMPT = `You write the opening summary of a progress report that a freelancer sends to a paying client.

You are given only: the project's name, the reporting period, and for each task its client-facing
label, its status, the hours recorded against it, and a one-line result the freelancer wrote
themselves. That is everything you know. You have no access to what applications were used, how
focused anyone was, or any other activity data, and you must never imply that you do.

Write one paragraph, three to five sentences, in plain professional English:
- Lead with what was completed, using the freelancer's own result lines as the source of truth.
- Say what is in progress and, if a task is blocked, say what it is waiting on.
- Never invent an accomplishment, a cause, or a detail that is not in the lines you were given.
- Never describe effort, focus, productivity, or how the work felt. Report outcomes only.
- Do not repeat the hours as a list; the report shows them in its own figures.
- Write as the freelancer, in first person plural or neutral voice. Never mention Ari or yourself.
- No greeting, no sign-off, no headings, no bullet points. One paragraph of prose.

If the lines are too thin to say anything true, write a single short sentence that says only what
is certain. Never pad.`;

/**
 * Build the model's input from a FIXED field list. This is the enforcement point — anything not
 * named here cannot reach the model, whatever else the caller happens to be holding.
 */
export function toSummaryFacts(request: SummaryRequest): string {
  const lines: string[] = [
    `Project: ${request.projectName}`,
    `Period: ${request.rangeStartLocal} to ${request.rangeEndLocal}`,
    '',
    'Tasks:'
  ];

  for (const task of request.tasks) {
    const parts = [
      `- ${task.clientLabel}`,
      `  status: ${task.status}`,
      `  hours: ${task.hours}`
    ];
    if (task.result.trim().length > 0) {
      parts.push(`  result: ${task.result.trim()}`);
    }
    if (task.status === 'blocked' && (task.blockedReason ?? '').trim().length > 0) {
      parts.push(`  waiting on: ${task.blockedReason!.trim()}`);
    }
    lines.push(...parts);
  }

  return lines.join('\n');
}

/**
 * Returns the drafted paragraph, or null when it could not be drafted. Never throws: a failure
 * here must leave the user typing their own summary, not staring at an error.
 */
export async function draftReportSummary(
  request: SummaryRequest,
  client?: Anthropic
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!client && !apiKey) {
    console.warn('[report-summary] ANTHROPIC_API_KEY not set — no draft.');
    return null;
  }

  if (request.tasks.length === 0) {
    return null;
  }

  const anthropic = client ?? new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS });

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Draft the summary for this report.\n\n${toSummaryFacts(request)}`
        }
      ]
    });

    // stop_reason must be checked before reading content — a refusal returns 200 with no text.
    if (message.stop_reason === 'refusal') {
      console.warn('[report-summary] Model declined — no draft.');
      return null;
    }

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    return text.length > 0 ? text : null;
  } catch (err) {
    console.error(
      '[report-summary] Failed to draft the summary:',
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}
