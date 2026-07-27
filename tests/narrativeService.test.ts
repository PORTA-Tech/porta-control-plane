import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  buildNarrativeLine,
  buildSituationFacts,
  tryConsumeCallBudget,
  resetNarrativeStateForTests,
  KIND_INSTRUCTION,
  NARRATIVE_DAILY_CALL_CAP,
  type NarrativeSituation,
} from '../src/core/narrativeService.js';
import { clearAccountStoreForTests, upsertAccountProfile } from '../src/store/accountStore.js';

// buildNarrativeLine only spends a model call on an account that actually exists — the
// endpoint is unauthenticated, so a made-up accountId must never reach Anthropic. Account
// ids are `uuid` columns, so these have to be well-formed UUIDs, not 'acc-1' style labels.
const ACCOUNT_A = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_CAP = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_OTHER = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_UNKNOWN = '44444444-4444-4444-8444-444444444444';

async function seedAccount(accountId: string): Promise<void> {
  const now = new Date().toISOString();
  await upsertAccountProfile({
    accountId,
    displayName: 'Test Account',
    primaryEmail: `${accountId}@example.test`,
    emailVerified: true,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
}

beforeEach(async () => {
  clearAccountStoreForTests();
  await Promise.all([seedAccount(ACCOUNT_A), seedAccount(ACCOUNT_CAP), seedAccount(ACCOUNT_OTHER)]);
});

// Part 5 contracts: grounding (only given facts appear), fail-soft (null on any failure — the
// agent's template takes over, never a generic line), and one call per moment (cache + daily cap).

function fakeClient(reply: string, stopReason = 'end_turn'): Anthropic {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        stop_reason: stopReason,
        content: [{ type: 'text', text: reply }],
      }),
    },
  } as unknown as Anthropic;
}

afterEach(() => {
  resetNarrativeStateForTests();
  vi.restoreAllMocks();
});

// Part 2a — the midday/eod cards render answer controls (buttons / plan box), so the model line must
// END with the question those controls answer. The old "no questions" / "do not ask" restriction is
// gone for these two kinds.
describe('KIND_INSTRUCTION (Part 2a)', () => {
  it('midday asks the progress question and drops the no-questions restriction', () => {
    expect(KIND_INSTRUCTION.midday).toContain('?');
    expect(KIND_INSTRUCTION.midday.toLowerCase()).not.toContain('no questions');
    expect(KIND_INSTRUCTION.midday.toLowerCase()).not.toContain('do not ask');
  });

  it('eod asks the tomorrow question and drops the no-questions restriction', () => {
    expect(KIND_INSTRUCTION.eod).toContain('?');
    expect(KIND_INSTRUCTION.eod.toLowerCase()).not.toContain('no questions');
    expect(KIND_INSTRUCTION.eod.toLowerCase()).not.toContain('do not ask');
  });
});

describe('buildSituationFacts', () => {
  const situation: NarrativeSituation = {
    goalToday: 'Ship the API',
    trackedSeconds: 3 * 3600,
    focusSeconds: 2 * 3600,
    focusQualityPct: 53,
    distractionSeconds: 30 * 60,
    localTimeHHmm: '13:05',
  };

  it('includes only what was given, formatted as measured facts', () => {
    const facts = buildSituationFacts('midday', situation, {});
    expect(facts).toContain('Today\'s stated goal: "Ship the API"');
    expect(facts).toContain('Time tracked at the computer so far today: 3h');
    expect(facts).toContain('Of that, focused: 2h');
    expect(facts).toContain('Focus quality so far: 53%');
    expect(facts).toContain('Local time: 13:05');
    // Nothing invented for absent fields:
    expect(facts).not.toContain('away');
    expect(facts).not.toContain('Yesterday');
  });

  it('surfaces the carried plan only while no goal is stated', () => {
    const withPlan = buildSituationFacts('morning', { carriedPlan: 'Finish the deck' }, {});
    expect(withPlan).toContain('Last night they planned for today: "Finish the deck"');

    const withGoal = buildSituationFacts('morning', { carriedPlan: 'Finish the deck', goalToday: 'Something else' }, {});
    expect(withGoal).not.toContain('Last night they planned');
  });

  it('includes the typed reply only for reply kinds', () => {
    const reply = buildSituationFacts('reply_morning', { userText: 'Write chapter 3' }, {});
    expect(reply).toContain('Their reply just now: "Write chapter 3"');

    const checkIn = buildSituationFacts('morning', { userText: 'Write chapter 3' }, {});
    expect(checkIn).not.toContain('Their reply just now');
  });

  it('surfaces the whole-day facts (Part 1b) only when closing the day', () => {
    const eod = buildSituationFacts('eod', { goalToday: 'Ship it', middaySkipped: true, awayGap: true }, {});
    expect(eod).toContain('midday check-in was never answered');
    expect(eod).toContain('away from the computer for a substantial stretch');

    // The same flags on a midday moment are not surfaced — they only frame the EOD wrap.
    const midday = buildSituationFacts('midday', { goalToday: 'Ship it', middaySkipped: true, awayGap: true }, {});
    expect(midday).not.toContain('midday check-in was never answered');
    expect(midday).not.toContain('away from the computer for a substantial stretch');
  });

  it('includes enrichment patterns when provided', () => {
    const facts = buildSituationFacts('morning', {}, {
      yesterdayGoal: 'Ship v2',
      yesterdayFocusSeconds: 4 * 3600,
      daysOfData: 12,
      focusTrend: 'improving',
      weakHour: 14,
    });
    expect(facts).toContain('Yesterday\'s goal was: "Ship v2"');
    expect(facts).toContain('Yesterday\'s focused time: 4h');
    expect(facts).toContain('Days of history: 12; focus trend: improving');
    expect(facts).toContain('Their usual weak hour: 14:00');
  });
});

describe('buildNarrativeLine', () => {
  it('returns the model line for a check-in moment', async () => {
    const line = await buildNarrativeLine(
      ACCOUNT_A, '2026-07-18', 'midday', { goalToday: 'Ship it' },
      fakeClient('You said the API was the day — 2h focused so far says protect the next hour for it.')
    );
    expect(line).toContain('protect the next hour');
  });

  // The endpoint is unauthenticated, and the daily cap is keyed on accountId — so without
  // this gate an attacker mints a fresh 16-call budget per made-up id, forever.
  it('never calls the model for an account that does not exist', async () => {
    const client = fakeClient('Should never be produced.');
    const line = await buildNarrativeLine(ACCOUNT_UNKNOWN, '2026-07-18', 'morning', {}, client);
    expect(line).toBeNull();
    expect((client.messages.create as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('never calls the model for a malformed account id', async () => {
    const client = fakeClient('Should never be produced.');
    const line = await buildNarrativeLine('not-a-uuid', '2026-07-18', 'morning', {}, client);
    expect(line).toBeNull();
    expect((client.messages.create as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('leaves the daily budget untouched when the account is rejected', async () => {
    const client = fakeClient('Should never be produced.');
    for (let i = 0; i < NARRATIVE_DAILY_CALL_CAP + 5; i++) {
      await buildNarrativeLine(ACCOUNT_UNKNOWN, '2026-07-18', 'reply_morning', { userText: `t${i}` }, client);
    }
    // Budget was never consumed, because the call never got that far.
    expect(tryConsumeCallBudget(ACCOUNT_UNKNOWN, '2026-07-18')).toBe(true);
  });

  it('caches check-in lines per account+kind+day — one model call per moment', async () => {
    const client = fakeClient('Morning line.');
    const first = await buildNarrativeLine(ACCOUNT_A, '2026-07-18', 'morning', {}, client);
    const second = await buildNarrativeLine(ACCOUNT_A, '2026-07-18', 'morning', {}, client);
    expect(first).toBe('Morning line.');
    expect(second).toBe('Morning line.');
    expect((client.messages.create as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache typed replies (each utterance differs)', async () => {
    const client = fakeClient('Reply line.');
    await buildNarrativeLine(ACCOUNT_A, '2026-07-18', 'reply_morning', { userText: 'a' }, client);
    await buildNarrativeLine(ACCOUNT_A, '2026-07-18', 'reply_morning', { userText: 'b' }, client);
    expect((client.messages.create as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });

  it('returns null on refusal', async () => {
    const line = await buildNarrativeLine(ACCOUNT_A, '2026-07-18', 'eod', {}, fakeClient('anything', 'refusal'));
    expect(line).toBeNull();
  });

  it('returns null on an unusable reply', async () => {
    const line = await buildNarrativeLine(ACCOUNT_A, '2026-07-18', 'eod', {}, fakeClient('short'));
    expect(line).toBeNull();
  });

  it('returns null when the call throws', async () => {
    const client = {
      messages: { create: vi.fn().mockRejectedValue(new Error('boom')) },
    } as unknown as Anthropic;
    const line = await buildNarrativeLine(ACCOUNT_A, '2026-07-18', 'morning', {}, client);
    expect(line).toBeNull();
  });

  it('returns null without a client or API key', async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const line = await buildNarrativeLine(ACCOUNT_A, '2026-07-18', 'morning', {});
      expect(line).toBeNull();
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('stops at the daily per-account cap', async () => {
    const client = fakeClient('A perfectly reasonable reply line for the cap test.');
    for (let i = 0; i < NARRATIVE_DAILY_CALL_CAP; i++) {
      const line = await buildNarrativeLine(ACCOUNT_CAP, '2026-07-18', 'reply_midday', { userText: `t${i}` }, client);
      expect(line).not.toBeNull();
    }
    const over = await buildNarrativeLine(ACCOUNT_CAP, '2026-07-18', 'reply_midday', { userText: 'over' }, client);
    expect(over).toBeNull();
    // A different account is unaffected.
    const other = await buildNarrativeLine(ACCOUNT_OTHER, '2026-07-18', 'reply_midday', { userText: 'x' }, client);
    expect(other).not.toBeNull();
  });
});

describe('tryConsumeCallBudget', () => {
  it('counts per account per day and resets across days', () => {
    for (let i = 0; i < NARRATIVE_DAILY_CALL_CAP; i++) {
      expect(tryConsumeCallBudget('acc-b', '2026-07-18')).toBe(true);
    }
    expect(tryConsumeCallBudget('acc-b', '2026-07-18')).toBe(false);
    expect(tryConsumeCallBudget('acc-b', '2026-07-19')).toBe(true);
  });
});
