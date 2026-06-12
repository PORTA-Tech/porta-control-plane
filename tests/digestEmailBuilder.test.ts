import { describe, expect, it } from 'vitest';
import { buildDigestEmail, type DailyDigestPayload } from '../src/core/digestEmailBuilder.js';

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

describe('buildDigestEmail honesty', () => {
  it('renders "no data" instead of 0m streak when the day had real focus', async () => {
    const { html } = await buildDigestEmail(buildPayload());
    // streak cell must NOT claim 0m as a fact
    expect(html).toContain('no data');
    expect(html).not.toMatch(/Longest streak<\/p>\s*<p[^>]*>0m</);
  });

  it('renders "no data" for fragmentation when episodes are 0 but distraction has hours', async () => {
    const { html } = await buildDigestEmail(buildPayload());
    expect(html).not.toMatch(/Fragmentation<\/p>\s*<p[^>]*>0 </);
  });

  it('keeps real values when the data is consistent', async () => {
    const { html } = await buildDigestEmail(buildPayload({
      longestFocusStreakSeconds: 2700, // 45m
      fragmentationEpisodeCount: 3,
      distractionSeconds: 3600
    }));
    expect(html).toContain('45m');
    expect(html).toContain('3 <span');
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
    // gaming and context switches show no data, social media still shows numbers
    const gamingSection = html.slice(html.indexOf('Gaming'));
    expect(gamingSection.slice(0, 300)).toContain('no data');
    const ctxSection = html.slice(html.indexOf('Context switches'));
    expect(ctxSection.slice(0, 300)).toContain('no data');
  });

  it('agent-path digests carry no fallback banner', async () => {
    const { html } = await buildDigestEmail(buildPayload({
      longestFocusStreakSeconds: 2700,
      fragmentationEpisodeCount: 2
    }));
    expect(html).not.toContain('offline at send time');
  });
});
