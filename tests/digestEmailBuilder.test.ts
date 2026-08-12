import { describe, expect, it } from 'vitest';
import {
  buildDigestEmail,
  isHighPressureDay,
  summarizeDay,
  NO_OUTCOME_LINE,
  type DailyDigestPayload,
  type DigestTaskEntry,
} from '../src/core/digestEmailBuilder.js';
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

const task = (o: Partial<DigestTaskEntry> = {}): DigestTaskEntry => ({
  title: 'Pricing page',
  plannedSeconds: 7200,
  actualSeconds: 4020,
  offtaskSeconds: 480,
  state: 'done',
  ...o,
});

// The §5c payload, with the values START_HERE documents.
const TIMELINE = [
  { hourLocal: 8, focusSeconds: 1980, activeSeconds: 900, awaySeconds: 720 },
  { hourLocal: 9, focusSeconds: 3120, activeSeconds: 300, awaySeconds: 180 },
  { hourLocal: 12, focusSeconds: 240, activeSeconds: 600, awaySeconds: 2760 },
  { hourLocal: 16, focusSeconds: 2820, activeSeconds: 480, awaySeconds: 300 },
];

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

// §5c item 3 — the headline goes through the SAME rule as UserCheckInTaskBoard.SummarizeDay.
// If these two ever diverge, the evening card and the email disagree about the same day, which
// is the bug the redesign replaced.
describe('summarizeDay — the card\'s rule, verbatim', () => {
  const board = (planned: number, finished: number): DigestTaskEntry[] =>
    Array.from({ length: planned }, (_, i) => task({ state: i < finished ? 'done' : 'pending' }));

  it.each([
    [1, 1, 'You planned one thing. You finished it.'],
    [1, 0, "You planned one thing. You didn't get to it."],
    [2, 1, 'You planned two things. You finished one.'],
    [2, 0, 'You planned two things. You finished none of them.'],
    [2, 2, 'You planned two things. You finished them all.'],
    [3, 2, 'You planned three things. You finished two.'],
    [4, 3, 'You planned 4 things. You finished three.'],
  ])('planned %i, finished %i', (planned, finished, expected) => {
    const s = summarizeDay(board(planned, finished))!;
    expect(`${s.planned} ${s.finished}`).toBe(expected);
  });

  it('invents no summary when nothing was planned', () => {
    expect(summarizeDay([])).toBeNull();
  });

  it('counts only "done" as finished — a moved task is not a finish', () => {
    const s = summarizeDay([
      task({ state: 'done' }),
      task({ state: 'pending', deferredUntilDay: '2026-08-12' }),
    ])!;
    expect(s.finished).toBe('You finished one.');
  });
});

describe('the digest renders the mock, top to bottom', () => {
  it('renders the thirteen sections in order', async () => {
    const { html } = await buildDigestEmail(buildPayload({
      longestFocusStreakSeconds: 6720,
      awaySeconds: 6960,
      dayTimeline: TIMELINE,
      // Both tasks still open: with no ANTHROPIC_API_KEY in the test environment, a board that
      // HAS an outcome omits Ari's take (the locked fail-soft contract), and this case needs the
      // section present to prove where it sits.
      tasks: [task({ state: 'pending' }), task({ title: 'Client revisions', plannedSeconds: 3600, actualSeconds: 1140, state: 'pending' })],
      topApps: [
        { label: 'claude', seconds: 16020 },
        { label: 'youtube', seconds: 1440, category: 1 },
      ],
    }));

    const order = [
      'by Porta',
      'Your day at a glance',
      'Friday, 12 June 2026',
      'You planned two things.',
      'The day',
      'Your tasks',
      'Worked',
      'Where your time went',
      'What pulled you off',
      "Ari's take",
      'Open Ari',
      'Sent by Ari',
    ];
    let cursor = -1;
    for (const marker of order) {
      const at = html.indexOf(marker);
      expect(at, `${marker} missing`).toBeGreaterThan(-1);
      expect(at, `${marker} out of order`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('carries the design values and never a light-theme colour', async () => {
    const { html } = await buildDigestEmail(buildPayload({ dayTimeline: TIMELINE }));
    expect(html).toContain('#14171C'); // card
    expect(html).toContain('#0B0D11'); // page
    expect(html).toContain('0.5px solid #2A3038'); // hairline border
    expect(html).not.toContain('#f4f4f8'); // the old light shell
    expect(html).not.toContain('fonts.googleapis.com');
  });

  it('puts the headline sentence on two lines and one line of context under it', async () => {
    const { html } = await buildDigestEmail(buildPayload({ tasks: [task()] }));
    expect(html).toContain('You planned one thing.<br>You finished it.');
    expect(html).toContain('2h 48m focused across a 6h 07m day.');
  });

  it('says "an" before an eight-hour day', async () => {
    const { html } = await buildDigestEmail(buildPayload({ trackedSeconds: 30900, focusSeconds: 23940 }));
    expect(html).toContain('6h 39m focused across an 8h 35m day.');
  });

  it('drops the headline sentence rather than invent one when nothing was planned', async () => {
    const { html } = await buildDigestEmail(buildPayload());
    expect(html).not.toContain('You planned');
    expect(html).toContain('focused across'); // the context line still stands
  });

  it('shows the offline notice only when it applies', async () => {
    const { html: agent } = await buildDigestEmail(buildPayload());
    expect(agent).not.toContain('offline at send time');
    const { html: cron } = await buildDigestEmail(buildPayload({ isServerFallback: true }));
    expect(cron).toContain('offline at send time');
  });
});

// §5c item 2 — THE DAY. And the degradation that matters tonight: an agent below 1.2.140
// sends no timeline at all.
describe('the timeline strip', () => {
  it('omits the whole section when the timeline is missing', async () => {
    for (const p of [buildPayload(), buildPayload({ dayTimeline: [] })]) {
      const { html } = await buildDigestEmail(p);
      expect(html).not.toContain('The day');
      expect(html).not.toContain('At the machine');
      expect(html).not.toContain('Gaps are hours your machine was off.');
      // and the sections around it still render
      expect(html).toContain('Your day at a glance');
      expect(html).toContain('Worked');
      expect(html).toContain('Open Ari');
    }
  });

  it('omits the section when every hour arrived zeroed', async () => {
    const { html } = await buildDigestEmail(buildPayload({
      dayTimeline: [{ hourLocal: 9, focusSeconds: 0, activeSeconds: 0, awaySeconds: 0 }],
    }));
    expect(html).not.toContain('The day');
  });

  it('renders cells that sum to exactly 100%', async () => {
    const { html } = await buildDigestEmail(buildPayload({ dayTimeline: TIMELINE }));
    const row = html.slice(html.indexOf('<tr style="height:14px;">'));
    const widths = [...row.slice(0, row.indexOf('</tr>')).matchAll(/width="(\d+)%"/g)].map((m) => Number(m[1]));
    expect(widths.length).toBeGreaterThan(3);
    expect(widths.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('renders a missing hour as bare track — never as away — and says so once', async () => {
    const { html } = await buildDigestEmail(buildPayload({ dayTimeline: TIMELINE }));
    const strip = html.slice(html.indexOf('The day'), html.indexOf('Focused &nbsp'));
    // 10:00 and 11:00 recorded nothing: a cell with no background at all.
    expect(strip).toMatch(/<td width="\d+%" style="font-size:0;/);
    expect(html).toContain('#171A20'); // the bare track, emptier than away
    expect(html.match(/Gaps are hours your machine was off\./g)).toHaveLength(1);
    // no fourth legend item
    expect(html).not.toContain('Nothing recorded');
  });

  it('says nothing about gaps on a day that has none', async () => {
    const { html } = await buildDigestEmail(buildPayload({
      dayTimeline: [
        { hourLocal: 9, focusSeconds: 3600, activeSeconds: 0, awaySeconds: 0 },
        { hourLocal: 10, focusSeconds: 1800, activeSeconds: 1800, awaySeconds: 0 },
      ],
    }));
    expect(html).toContain('The day');
    expect(html).not.toContain('Gaps are hours');
  });

  it('labels the ends of the span with am/pm', async () => {
    const { html } = await buildDigestEmail(buildPayload({ dayTimeline: TIMELINE }));
    expect(html).toContain('>8am<');
    expect(html).toContain('>4pm<');
  });
});

// §5c item 4 — a moved task reads "moved on", never as a failure, never the accent.
describe('the tasks section', () => {
  it('gives a finished task the accent, a check and its measured times', async () => {
    const { html } = await buildDigestEmail(buildPayload({ tasks: [task()] }));
    const block = html.slice(html.indexOf('Your tasks'));
    expect(block).toContain('&#10003;');
    expect(block).toContain('Pricing page');
    expect(block).toContain('>1h 07m<');
    expect(block).toContain('planned 2h');
    expect(block).toContain(`background:#3FBF7F`);
  });

  it('reads a moved task as "moved on", in grey, never green', async () => {
    const { html } = await buildDigestEmail(buildPayload({
      tasks: [task({ title: 'Client revisions', plannedSeconds: 3600, actualSeconds: 1140, state: 'pending', deferredUntilDay: '2026-08-12' })],
    }));
    const block = html.slice(html.indexOf('Your tasks'), html.indexOf('Worked'));
    expect(block).toContain('moved on');
    expect(block).toContain('>19m<');
    expect(block).toContain('background:#5A626D'); // at-the-machine grey
    expect(block).not.toContain('background:#3FBF7F'); // THE GREEN RULE
    expect(block).not.toContain('&#10003;');
    expect(block.toLowerCase()).not.toContain('fail');
    expect(block.toLowerCase()).not.toContain('missed');
  });

  it('omits the section entirely when there are no tasks', async () => {
    for (const p of [buildPayload(), buildPayload({ tasks: [] })]) {
      const { html } = await buildDigestEmail(p);
      expect(html).not.toContain('Your tasks');
    }
  });

  it('escapes task titles (user-authored text)', async () => {
    const { html } = await buildDigestEmail(buildPayload({
      tasks: [task({ title: '<script>x</script>' })],
    }));
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('the four figures', () => {
  it('renders worked, focused, best run and away — and no breaks tile', async () => {
    const { html } = await buildDigestEmail(buildPayload({
      longestFocusStreakSeconds: 6720,
      awaySeconds: 6960,
      breaksSuggestedCount: 6,
    }));
    expect(html).toContain('Worked');
    expect(html).toContain('>6h 07m<');
    expect(html).toContain('Best run');
    expect(html).toContain('>1h 52m<');
    expect(html).toContain('Away');
    expect(html).toContain('>1h 56m<');
    expect(html).not.toContain('Breaks');
    expect(html).not.toContain('0/6');
    // the away sentence the figure replaced
    expect(html).not.toContain('not counted as work');
  });

  it('renders "no data" rather than a confident 0m best run', async () => {
    const { html } = await buildDigestEmail(buildPayload());
    expect(html).toContain('no data');
  });

  it('renders none of the cut jargon metrics', async () => {
    const { html } = await buildDigestEmail(buildPayload({
      longestFocusStreakSeconds: 2700,
      fragmentationEpisodeCount: 3,
      contextSwitchCount: 12,
      distractionSeconds: 3600,
    }));
    expect(html).not.toContain('Fragmentation');
    expect(html).not.toContain('Context switches');
    expect(html).not.toContain('Focus Quality');
    expect(html).not.toContain('Quality');
    expect(html).not.toContain('Time Breakdown');
    expect(html).not.toContain('Not yet');
  });
});

// §5c item 7 — UNRECOGNISED TIME IS NOT SHOWN.
describe('where your time went', () => {
  it('drops the residue rows entirely', async () => {
    const { html } = await buildDigestEmail(buildPayload({
      topApps: [
        { label: 'claude', seconds: 16020 },
        { label: 'web', seconds: 1800 },
        { label: 'Other browsing', seconds: 1800 },
        { label: 'Unnamed', seconds: 2550 },
      ],
    }));
    expect(html).toContain('Where your time went');
    expect(html).toContain('claude');
    expect(html).not.toContain('Other browsing');
    expect(html).not.toContain('Unnamed');
    expect(html).not.toMatch(/>web</);
  });

  it('omits the section when residue is all there was', async () => {
    const { html } = await buildDigestEmail(buildPayload({
      topApps: [{ label: 'web', seconds: 1800 }, { label: 'Unnamed', seconds: 900 }],
    }));
    expect(html).not.toContain('Where your time went');
  });

  it('scales the bars against the top row', async () => {
    const { html } = await buildDigestEmail(buildPayload({
      topApps: [{ label: 'claude', seconds: 16020 }, { label: 'github', seconds: 3840 }],
    }));
    const section = html.slice(html.indexOf('Where your time went'));
    expect(section).toContain('width="24%"');
  });
});

// §5c item 5 — nothing to show → the whole section, its label included, is omitted.
describe('what pulled you off', () => {
  it('is omitted entirely when no row has a real number', async () => {
    for (const p of [
      buildPayload(),
      buildPayload({ topApps: [{ label: 'claude', seconds: 16020, category: 2 }] }),
      buildPayload({ topApps: [{ label: 'youtube', seconds: 0, category: 1 }] }),
      buildPayload({ distractionSeconds: 11460, socialMediaLoopCount: 4 }),
    ]) {
      const { html } = await buildDigestEmail(p);
      expect(html).not.toContain('What pulled you off');
      expect(html).not.toContain('no data</span>\n');
    }
  });

  it('renders only the rows that have real numbers', async () => {
    const { html } = await buildDigestEmail(buildPayload({
      topApps: [
        { label: 'claude', seconds: 16020, category: 2 },
        { label: 'youtube', seconds: 1440, category: 1 },
        { label: 'twitter', seconds: 660, category: 3 },
      ],
    }));
    const section = html.slice(html.indexOf('What pulled you off'));
    expect(section).toContain('youtube');
    expect(section).toContain('24m');
    expect(section).toContain('twitter');
    expect(section).toContain('11m');
  });
});

// §5c item 6 — built from actual task outcomes; when it cannot see one it says so.
describe("Ari's take", () => {
  it('says so, in serif, when the board shows no outcome', async () => {
    const { html } = await buildDigestEmail(buildPayload());
    expect(html).toContain("Ari's take");
    expect(html).toContain(NO_OUTCOME_LINE);
    expect(html).toContain('Georgia');
  });

  it('says so when tasks exist but none of them ended', async () => {
    const { html } = await buildDigestEmail(buildPayload({
      tasks: [task({ state: 'pending' })],
    }));
    expect(html).toContain(NO_OUTCOME_LINE);
  });

  it('omits the section when the model cannot be reached on a day that HAS outcomes', async () => {
    // No ANTHROPIC_API_KEY in the test environment: buildAriTake returns null and the section
    // is omitted rather than falling back to the old generic streak line.
    const { html } = await buildDigestEmail(buildPayload({ tasks: [task({ state: 'done' })] }));
    expect(html).not.toContain("Ari's take");
    expect(html).not.toContain('days in a row with focus above');
  });
});

describe('the subject line', () => {
  it('keeps the streak subject', async () => {
    const { subject } = await buildDigestEmail(
      buildPayload(),
      'porta://open',
      { consecutiveStreak: 9, daysOfData: 12 } as unknown as UserHistory
    );
    expect(subject).toBe('9 days in a row — Friday, 12 June 2026');
  });
});
