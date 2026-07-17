import { describe, it, expect, vi } from 'vitest';
import { buildAriTake, buildNarrativeFacts } from '../src/core/digestNarrative.js';
import type { DailyDigestPayload } from '../src/core/digestEmailBuilder.js';

// C2 / C-decision — "Ari's take" is LLM-written from the day's real numbers. The two behaviors
// that matter: (1) the fact sheet only ever contains measured values (the W5 grounding rule — the
// model cannot narrate a number it was never given), and (2) the call fails SOFT — a digest must
// still send without this section rather than fall back to the generic streak line.

const base: DailyDigestPayload = {
  accountId: 'acct-1',
  deviceId: 'dev-1',
  machineId: 'machine-1',
  dateLocal: '2026-07-16',
  timezoneOffsetMinutes: 240,
  reportedAtUtc: '2026-07-16T19:30:00Z',
  trackedSeconds: 6 * 3600,
  focusSeconds: 3 * 3600 + 30 * 60,
  focusQualityScore: 0.7,
  distractionSeconds: 40 * 60,
  awaySeconds: 25 * 60,
  contextExcursionSeconds: 0,
  longestFocusStreakSeconds: 52 * 60,
  fragmentationEpisodeCount: 3,
  socialMediaLoopCount: 2,
  gamingEpisodeCount: 0,
  socialMediaSeconds: 0,
  gamingLauncherSeconds: 0,
  gamingActiveSeconds: 0,
  passiveConsumptionSeconds: 0,
  commMonitoringReturnCount: 0,
  socialMediaReturnCount: 2,
  overloadEpisodeCount: 0,
  breaksTakenCount: 2,
  breaksSuggestedCount: 3,
  mostDistractedHourLabel: '14:00-14:59',
  developmentSeconds: 0,
  productivitySeconds: 0,
  communicationSeconds: 0,
  entertainmentSeconds: 0,
};

/** Minimal fake — only the shape buildAriTake touches. */
function fakeClient(reply: unknown) {
  return { messages: { create: vi.fn().mockResolvedValue(reply) } } as never;
}

describe('buildNarrativeFacts (W5 grounding)', () => {
  it('includes the goal and the midday answer in plain language', () => {
    const facts = buildNarrativeFacts({ ...base, goal: 'Ship the release', middayAnswer: 'partly' });
    expect(facts).toContain('Ship the release');
    expect(facts).toContain('partly');
  });

  it('says plainly when no goal was set rather than inventing one', () => {
    const facts = buildNarrativeFacts(base);
    expect(facts).toContain('did not set a goal');
  });

  it('omits metrics that are zero instead of feeding the model a fabricated figure', () => {
    // A day with no distraction, no away time, no streak, and no breaks suggested: none of those
    // may appear in the fact sheet, or the model could narrate a measurement we never made.
    const facts = buildNarrativeFacts({
      ...base,
      distractionSeconds: 0,
      awaySeconds: 0,
      longestFocusStreakSeconds: 0,
      breaksSuggestedCount: 0,
    });
    expect(facts).not.toContain('distracting');
    expect(facts).not.toContain('Away from the computer');
    expect(facts).not.toContain('Longest unbroken');
    expect(facts).not.toContain('Breaks Ari suggested');
    // ...but the measured ones stay.
    expect(facts).toContain('Time tracked');
    expect(facts).toContain('focused');
  });

  it('formats durations the way the email does, and names real apps', () => {
    const facts = buildNarrativeFacts({
      ...base,
      topApps: [
        { label: 'code', seconds: 7200 },
        { label: 'youtube', seconds: 1800 },
      ],
    });
    expect(facts).toContain('6h');       // tracked
    expect(facts).toContain('3h 30m');   // focused
    expect(facts).toContain('code 2h');
    expect(facts).toContain('youtube 30m');
  });
});

describe('buildAriTake failure contract', () => {
  it('returns the paragraph when the model replies usefully', async () => {
    const client = fakeClient({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'You set out to ship the release and spent 3h 30m focused on it.' }],
    });
    const take = await buildAriTake({ ...base, goal: 'Ship the release' }, client);
    expect(take).toContain('3h 30m');
  });

  it('returns null when the call throws — the digest still sends, minus the section', async () => {
    const client = { messages: { create: vi.fn().mockRejectedValue(new Error('boom')) } } as never;
    expect(await buildAriTake(base, client)).toBeNull();
  });

  it('returns null on a refusal rather than rendering empty content', async () => {
    const client = fakeClient({ stop_reason: 'refusal', content: [] });
    expect(await buildAriTake(base, client)).toBeNull();
  });

  it('returns null on an unusably short reply', async () => {
    const client = fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] });
    expect(await buildAriTake(base, client)).toBeNull();
  });

  it('returns null when no API key is configured', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(await buildAriTake(base)).toBeNull();
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it('never sends sampling params — they are rejected on this model', async () => {
    const create = vi.fn().mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'A specific, grounded sentence about the day just measured.' }],
    });
    await buildAriTake(base, { messages: { create } } as never);
    const params = create.mock.calls[0][0];
    expect(params.temperature).toBeUndefined();
    expect(params.top_p).toBeUndefined();
    expect(params.top_k).toBeUndefined();
    expect(params.model).toBe('claude-opus-4-8');
  });
});
