import {
  APP_CATEGORY_NAMES,
  isAppCategoryName,
  listPending,
  upsertResolved,
  type AppCategoryName,
  type ResolvedLabel
} from '../store/appCategoryLabelStore.js';

/**
 * 2d — server-side categorizer worker. Drains tokens the agents could not classify locally
 * (queued 'pending' by POST /api/agent/categories/resolve) and asks Claude Haiku to map each to
 * one of the 8 AppCategory names, in a single batched call. Results are written back with
 * source='llm' so agents pick them up on their next resolve.
 *
 * Cost discipline: cache-first (only ever classifies tokens with no resolved row), one API call
 * per drain of up to BATCH_LIMIT tokens, and a hard per-UTC-day call cap so a misbehaving fleet
 * can never run the bill away. Fails safe — any error leaves tokens pending for the next pass.
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const BATCH_LIMIT = 50;
const MAX_CALLS_PER_DAY = 200;
const REQUEST_TIMEOUT_MS = 20_000;

// The 8 category names minus the reasons a token would be Unknown, offered to the model as the
// closed set it must choose from.
const CATEGORY_CHOICES = APP_CATEGORY_NAMES.join(', ');

let callsToday = 0;
let callsDayKey = '';
let missingKeyWarned = false;
let draining = false;

function todayUtcKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Returns true and increments the counter if we're under the daily cap; false if capped. */
function tryConsumeDailyBudget(): boolean {
  const key = todayUtcKey();
  if (key !== callsDayKey) {
    callsDayKey = key;
    callsToday = 0;
  }
  if (callsToday >= MAX_CALLS_PER_DAY) {
    return false;
  }
  callsToday += 1;
  return true;
}

function buildPrompt(tokens: string[]): string {
  return [
    'Classify each of the following software / website identity tokens into exactly one category.',
    'A token is a short lowercase name of an app or site, e.g. "notion", "figma", "steam", "roblox".',
    '',
    `Allowed categories (choose exactly one per token): ${CATEGORY_CHOICES}.`,
    'Guidance: Development = coding/dev tools; Productivity = work/docs/notes/design;',
    'Communication = chat/email/meetings; SocialMedia = social feeds; Entertainment = video/music/streaming;',
    'Gaming = a game itself; GamingLauncher = a game store/launcher. Use "Unknown" only if genuinely unclassifiable.',
    '',
    'Respond with ONLY a JSON object mapping each token to its category, no prose, no code fence. Example:',
    '{"notion":"Productivity","steam":"GamingLauncher"}',
    '',
    'Tokens:',
    JSON.stringify(tokens)
  ].join('\n');
}

interface AnthropicTextResponse {
  content?: Array<{ type?: string; text?: string }>;
}

/** Extracts the first text block from an Anthropic messages response. */
function extractText(body: AnthropicTextResponse): string {
  if (!Array.isArray(body.content)) return '';
  for (const block of body.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      return block.text;
    }
  }
  return '';
}

/** Parses the model's JSON reply into validated {token -> category} pairs, dropping anything off-list. */
export function parseCategoryReply(text: string, requested: string[]): Record<string, AppCategoryName> {
  const requestedSet = new Set(requested);
  const out: Record<string, AppCategoryName> = {};

  // Be tolerant of a stray code fence or leading prose: grab the first {...} block.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return out;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object') return out;

  for (const [token, category] of Object.entries(parsed as Record<string, unknown>)) {
    if (requestedSet.has(token) && isAppCategoryName(category)) {
      out[token] = category;
    }
  }
  return out;
}

/**
 * Calls Claude Haiku to classify a batch of tokens. Returns validated mappings, or an empty
 * object on any failure (tokens then stay pending for a later pass). `fetchImpl` is injectable
 * for tests.
 */
export async function classifyTokens(
  tokens: string[],
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<Record<string, AppCategoryName>> {
  if (tokens.length === 0) return {};

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        temperature: 0,
        system: 'You are a precise classifier. You only ever output a single JSON object and nothing else.',
        messages: [{ role: 'user', content: buildPrompt(tokens) }]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      console.error(`[appCategoryWorker] Anthropic HTTP ${response.status}`);
      return {};
    }

    const body = (await response.json()) as AnthropicTextResponse;
    return parseCategoryReply(extractText(body), tokens);
  } catch (err) {
    console.error(
      '[appCategoryWorker] classify failed:',
      err instanceof Error ? err.message : String(err)
    );
    return {};
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * One drain pass: pull pending tokens, classify them, persist. Safe to call on an interval.
 * No-op (returns 0) when there is no API key, nothing pending, or the daily budget is spent.
 */
export async function runAppCategoryCategorization(
  fetchImpl: typeof fetch = fetch
): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    if (!missingKeyWarned) {
      console.warn('[appCategoryWorker] ANTHROPIC_API_KEY not set — categorization disabled.');
      missingKeyWarned = true;
    }
    return 0;
  }

  if (draining) return 0;
  draining = true;
  try {
    const pending = await listPending(BATCH_LIMIT);
    if (pending.length === 0) return 0;

    if (!tryConsumeDailyBudget()) {
      console.warn('[appCategoryWorker] daily categorization budget reached — deferring.');
      return 0;
    }

    const mappings = await classifyTokens(pending, apiKey, fetchImpl);
    const resolved: ResolvedLabel[] = Object.entries(mappings).map(([token, category]) => ({
      token,
      category,
      source: 'llm',
      modelVer: MODEL
    }));

    if (resolved.length > 0) {
      await upsertResolved(resolved);
    }
    return resolved.length;
  } finally {
    draining = false;
  }
}

/** Test-only: reset the daily-budget + warning state between cases. */
export function resetAppCategoryWorkerStateForTests(): void {
  callsToday = 0;
  callsDayKey = '';
  missingKeyWarned = false;
  draining = false;
}
