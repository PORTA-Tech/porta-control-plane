import { describe, expect, it } from 'vitest';
import { buildDigestEmail, isHighPressureDay, type DailyDigestPayload } from '../src/core/digestEmailBuilder.js';
import type { UserHistory } from '../src/store/userHistoryStore.js';

const hist = (avgPressurePct: number): UserHistory => ({ avgPressurePct } as unknown as UserHistory);

// Payload modeled on the real 2026-06-12 digest that contradicted itself:
// 6h07m tracked, 2h48m focus, yet "Longest streak 0m" and an all-zero
// Time Breakdown rendered as facts.
function buildPayload(overrides: Partial<DailyDigestPayload> = {}): DailyDigestPayload {
  return {
    accountId: 'acct-1',
    deviceId: 'dev-1',
    machineId: 'DESKTOP-TEST',
    dateLocal: '2026-06-12',
    timezoneOffsetMinutes: 240,
    reportedAtUtc: '2026-06-12T19:30:00.000Z',
    trackedSeconds: 22020, // 6h07m
    focusSeconds: 10080, // 2h48m
    focusQualityScore: 0.5,
    distractionSeconds: 11460, // 3h11m
    awaySeconds: 0,
    contextExcursionSeconds: 0,
    longestFocusStreakSeconds: 0,
    fragmentationEpisodeCount: 0,
    socialMediaLoopCount: 0,
    gamingEpisodeCount: 0,
    socialMediaSeconds: 0,
    gamingLauncherSeconds: 0,
    gamingActiveSeconds: 0,
    passiveConsumptionSeconds: 0,
    commMonitoringReturnCount: 0,
    socialMediaReturnCount: 0,
    overloadEpisodeCount: 0,
    breaksTakenCount: 0,
    breaksSuggestedCount: 0,
    mostDistractedHourLabel: 'n/a',
    developmentSeconds: 0,
    productivitySeconds: 0,
    communicationSeconds: 0,
    entertainmentSeconds: 0,
    ...overrides
  };
}

describe('isHighPressureDay', () => {
  it('fires on real overload events regardless of pressure', () => {
    expect(isHighPressureDay(buildPayload({ overloadEpisodeCount: 2 }), hist(30))).toBe(true);
  });

  it('fires when the day pressure is clearly above the user baseline', () => {
    // baseline 30 -> needs >= 30*1.3 (39) and >= 30+8 (38); 50 clears both.
    expect(isHighPressureDay(buildPayload({ pressureAvgPct: 50 }), hist(30))).toBe(true);
  });

  it('does not fire when pressure is only near the baseline', () => {
    expect(isHighPressureDay(buildPayload({ pressureAvgPct: 34 }), hist(30))).toBe(false);
  });

  it('does not fire without a baseline or without a pressure value', () => {
    expect(isHighPressureDay(buildPayload({ pressureAvgPct: 80 }), null)).toBe(false);
    expect(isHighPressureDay(buildPayload({ pressureAvgPct: undefined }), hist(30))).toBe(false);
  });
});

describe('buildDigestEmail honesty', () => {
  it('renders "no data" instead of 0m streak when the day had real focus', async () => {
    const { html } = await buildDigestEmail(buildPayload());
    // streak cell must NOT claim 0m as a fact
    expect(html).toContain('no data');
    expect(html).not.toMatch(/Longest streak<\/p>\s*<p[^>]*>0m</);
  });

  // C3 — jargon the user can't act on is cut from the USER-FACING digest (still measured, still
  // uploaded, still in daily_stats). A metric nobody understands reads as filler.
  it('renders none of the cut jargon metrics', async () => {
    const { html } = await buildDigestEmail(buildPayload({
      longestFocusStreakSeconds: 2700,
      fragmentationEpisodeCount: 3,
      contextSwitchCount: 12,
      contextExcursionSeconds: 900,
      distractionSeconds: 3600
    }));
    expect(html).not.toContain('Fragmentation');
    expect(html).not.toContain('Context switches');
    expect(html).not.toContain('Focus Quality');
    expect(html).not.toContain('Quality');
  });

  it('keeps real values when the data is consistent', async () => {
    const { html } = await buildDigestEmail(buildPayload({
      longestFocusStreakSeconds: 2700, // 45m — the C0 "Best run" stat
      fragmentationEpisodeCount: 3,
      distractionSeconds: 3600
    }));
    expect(html).toContain('45m');
    expect(html).toContain('Best run');
    expect(html).not.toContain('no data');
  });

  it('never renders the fabricated Time Breakdown section', async () => {
    const { html } = await buildDigestEmail(buildPayload({
      developmentSeconds: 3600,
      productivitySeconds: 1800
    }));
    expect(html).not.toContain('Time Breakdown');
    expect(html).not.toContain('Development');
  });

  it('marks server-fallback digests and respects declared missing fields', async () => {
    const { html } = await buildDigestEmail(buildPayload({
      longestFocusStreakSeconds: 2700,
      fragmentationEpisodeCount: 5,
      isServerFallback: true,
      missingFields: ['gaming', 'contextSwitches']
    }));
    expect(html).toContain('offline at send time');
    // Gaming is declared missing and still renders "no data" rather than a confident 0.
    const gamingSection = html.slice(html.indexOf('Gaming'));
    expect(gamingSection.slice(0, 300)).toContain('no data');
    // 'contextSwitches' stays a valid missing-field declaration on the payload (the metric is
    // still measured and uploaded), but C3 removed it from the user-facing email entirely — so
    // there is no longer a section for it to mark.
    expect(html).not.toContain('Context switches');
  });

  it('agent-path digests carry no fallback banner', async () => {
    const { html } = await buildDigestEmail(buildPayload({
      longestFocusStreakSeconds: 2700,
      fragmentationEpisodeCount: 2
    }));
    expect(html).not.toContain('offline at send time');
  });
});

// W5 — per-section completeness gates: a section without real inputs is OMITTED,
// never rendered with placeholders or generic text.
describe('buildDigestEmail section gating', () => {
  it('omits top-apps and distraction sections when topApps is empty', async () => {
    const { html } = await buildDigestEmail(buildPayload());
    expect(html).not.toContain('Where your time went');
    expect(html).not.toContain('What pulled you off task');
  });

  it('renders top apps when present, with residual "web" as "Other browsing"', async () => {
    const { html } = await buildDigestEmail(buildPayload({
      topApps: [
        { label: 'github', seconds: 3600 },
        { label: 'web', seconds: 1800 }
      ]
    }));
    expect(html).toContain('Where your time went');
    expect(html).toContain('Github');
    expect(html).toContain('Other browsing');
    expect(html).not.toMatch(/>Web</);
  });
});

// W4 — "Plan vs. reality": present iff the day has closed tasks, and every number in
// the HTML is exactly the payload's measured value.
describe('buildDigestEmail plan vs. reality', () => {
  it('omits the section entirely when there are no tasks', async () => {
    const { html: none } = await buildDigestEmail(buildPayload());
    expect(none).not.toContain('Plan vs. reality');
    const { html: empty } = await buildDigestEmail(buildPayload({ tasks: [] }));
    expect(empty).not.toContain('Plan vs. reality');
  });

  it('renders one line per closed task with the exact measured numbers', async () => {
    const { html } = await buildDigestEmail(buildPayload({
      tasks: [
        { title: 'write digest section', plannedSeconds: 3600, actualSeconds: 4440, offtaskSeconds: 720, state: 'done' },
        { title: 'inbox sweep', plannedSeconds: 1800, actualSeconds: 900, offtaskSeconds: 0, state: 'abandoned' }
      ]
    }));
    expect(html).toContain('Plan vs. reality');
    expect(html).toContain('write digest section');
    expect(html).toContain('planned 1h · took 1h 14m · 12m off-task');
    expect(html).toContain('✕ inbox sweep');
    expect(html).toContain('planned 30m · took 15m');
  });

  it('escapes task titles (user-authored text)', async () => {
    const { html } = await buildDigestEmail(buildPayload({
      tasks: [
        { title: '<script>x</script>', plannedSeconds: 1800, actualSeconds: 1800, offtaskSeconds: 0, state: 'done' }
      ]
    }));
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
