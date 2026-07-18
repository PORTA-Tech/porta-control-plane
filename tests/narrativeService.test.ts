import { afterEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  buildNarrativeLine,
  buildSituationFacts,
  tryConsumeCallBudget,
  resetNarrativeStateForTests,
  NARRATIVE_DAILY_CALL_CAP,
  type NarrativeSituation,
} from '../src/core/narrativeService.js';

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
      'acc-1', '2026-07-18', 'midday', { goalToday: 'Ship it' },
      fakeClient('You said the API was the day — 2h focused so far says protect the next hour for it.')
    );
    expect(line).toContain('protect the next hour');
  });

  it('caches check-in lines per account+kind+day — one model call per moment', async () => {
    const client = fakeClient('Morning line.');
    const first = await buildNarrativeLine('acc-1', '2026-07-18', 'morning', {}, client);
    const second = await buildNarrativeLine('acc-1', '2026-07-18', 'morning', {}, client);
    expect(first).toBe('Morning line.');
    expect(second).toBe('Morning line.');
    expect((client.messages.create as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache typed replies (each utterance differs)', async () => {
    const client = fakeClient('Reply line.');
    await buildNarrativeLine('acc-1', '2026-07-18', 'reply_morning', { userText: 'a' }, client);
    await buildNarrativeLine('acc-1', '2026-07-18', 'reply_morning', { userText: 'b' }, client);
    expect((client.messages.create as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });

  it('returns null on refusal', async () => {
    const line = await buildNarrativeLine('acc-1', '2026-07-18', 'eod', {}, fakeClient('anything', 'refusal'));
    expect(line).toBeNull();
  });

  it('returns null on an unusable reply', async () => {
    const line = await buildNarrativeLine('acc-1', '2026-07-18', 'eod', {}, fakeClient('short'));
    expect(line).toBeNull();
  });

  it('returns null when the call throws', async () => {
    const client = {
      messages: { create: vi.fn().mockRejectedValue(new Error('boom')) },
    } as unknown as Anthropic;
    const line = await buildNarrativeLine('acc-1', '2026-07-18', 'morning', {}, client);
    expect(line).toBeNull();
  });

  it('returns null without a client or API key', async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const line = await buildNarrativeLine('acc-1', '2026-07-18', 'morning', {});
      expect(line).toBeNull();
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('stops at the daily per-account cap', async () => {
    const client = fakeClient('A perfectly reasonable reply line for the cap test.');
    for (let i = 0; i < NARRATIVE_DAILY_CALL_CAP; i++) {
      const line = await buildNarrativeLine('acc-cap', '2026-07-18', 'reply_midday', { userText: `t${i}` }, client);
      expect(line).not.toBeNull();
    }
    const over = await buildNarrativeLine('acc-cap', '2026-07-18', 'reply_midday', { userText: 'over' }, client);
    expect(over).toBeNull();
    // A different account is unaffected.
    const other = await buildNarrativeLine('acc-other', '2026-07-18', 'reply_midday', { userText: 'x' }, client);
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
