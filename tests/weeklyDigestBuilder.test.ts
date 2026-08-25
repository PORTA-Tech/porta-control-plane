import { describe, expect, it } from 'vitest';
import {
  buildWeeklyDigestEmail,
  formatWeekRange,
  NO_TAKE_LINE,
  type WeeklyDigestPayload,
} from '../src/core/weeklyDigestBuilder.js';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function days(focusHours: Array<number | null>): WeeklyDigestPayload['days'] {
  // null = the machine was off that day. 0 = worked, nothing focused. The two must not render alike.
  return focusHours.map((h, i) => ({
    dateLocal: `2026-08-${String(17 + i).padStart(2, '0')}`,
    label: DAY_LABELS[i]!,
    focusSeconds: h === null ? 0 : Math.round(h * 3600),
    worked: h !== null,
  }));
}

function buildPayload(overrides: Partial<WeeklyDigestPayload> = {}): WeeklyDigestPayload {
  return {
    deviceId: 'dev-1',
    machineId: 'DESKTOP-TEST',
    weekStartLocal: '2026-08-17',
    weekEndLocal: '2026-08-23',
    timezoneOffsetMinutes: 240,
    reportedAtUtc: '2026-08-23T19:30:00.000Z',
    plannedCount: 18,
    finishedCount: 11,
    trackedSeconds: 148320, // 41h 12m
    focusSeconds: 114000, // 31h 40m
    awaySeconds: 34320, // 9h 32m
    days: days([6.2, 7.4, 5.1, 8.0, 3.5, 1.5, null]),
    finished: [
      { title: 'Rewrite onboarding email', project: 'Northbridge', seconds: 5100 },
      { title: 'Send March invoices', project: 'Admin', seconds: 2400 },
    ],
    carried: [
      { title: 'Landing page copy', project: 'Northbridge', seconds: 7800, daysOpen: 3 },
    ],
    projects: [
      { name: 'PORTA', seconds: 52560 },
      { name: 'Target Prospect', seconds: 29520 },
    ],
    ariTake: 'Eleven of eighteen closed.',
    ...overrides,
  };
}

describe('the resume', () => {
  it('scores planned and finished, and never recomputes them from the lists', () => {
    // The counts are the AGENT's score, through the same rule as the evening card. If this section
    // derived its own numbers from `finished.length` the weekly and the daily could disagree about
    // what finished means, which is the bug it exists to avoid.
    const { html } = buildWeeklyDigestEmail(buildPayload({
      plannedCount: 18, finishedCount: 11,
      finished: [{ title: 'One thing', project: 'PORTA', seconds: 600 }],
    }));
    expect(html).toContain('You planned 18 things.');
    expect(html).toContain('You finished 11.');
  });

  it('counts worked days in words, and never counts a day the machine was off', () => {
    const { html } = buildWeeklyDigestEmail(buildPayload());
    expect(html).toContain('focused across six worked days.');
  });

  it('says so rather than printing a confident zero when focus was never recorded', () => {
    const { html } = buildWeeklyDigestEmail(buildPayload({ missingFields: ['focus'] }));
    expect(html).toContain("Focused time wasn't recorded this week.");
    expect(html).toContain('no data');
  });
});

describe('the week strip', () => {
  it('renders a day not worked as an empty track, never as a zero-height bar', () => {
    const { html } = buildWeeklyDigestEmail(buildPayload());
    // Sunday is not worked: it prints an em dash, not "0.0h".
    expect(html).toContain('&mdash;');
    expect(html).not.toContain('>0.0h<');
    // and it names the gap rather than leaving it to be read as a bad day
    expect(html).toContain('Sun not worked.');
    // no zero-height fill anywhere
    expect(html).not.toMatch(/height:0px;background:#3FBF7F/);
  });

  it('scales every bar against the best day and states each height inline', () => {
    const { html } = buildWeeklyDigestEmail(buildPayload());
    // Thursday is the peak at 8.0h, so it fills the full 64px track.
    expect(html).toContain('height:64px;background:#3FBF7F');
    // Monday at 6.2h of 8.0h => round(6.2/8*64) = 50
    expect(html).toContain('height:50px;background:#3FBF7F');
    // Saturday at 1.5h => round(1.5/8*64) = 12
    expect(html).toContain('height:12px;background:#3FBF7F');
  });

  it('keeps measured focus visible rather than rounding it away', () => {
    // Six minutes against an eight hour peak rounds to 0px. It must floor to 2px instead: time that
    // was measured has to be visible, or the strip quietly denies it happened.
    const { html } = buildWeeklyDigestEmail(buildPayload({
      days: days([8.0, 0.1, 4, 4, 4, 4, 4]),
    }));
    expect(html).toContain('height:2px;background:#3FBF7F');
  });

  it('becomes a sentence below three worked days, and still names every day', () => {
    const { html } = buildWeeklyDigestEmail(buildPayload({
      days: days([6.2, null, null, 2.0, null, null, null]),
    }));
    expect(html).toContain('Too few worked days this week to draw a shape.');
    expect(html).toContain('Mon');
    expect(html).toContain('Thu');
    expect(html).toContain('(6.2h)');
    expect(html).toContain('(2.0h)');
    // no strip
    expect(html).not.toContain('background:#171A20');
  });

  it('draws the strip at exactly three worked days', () => {
    const { html } = buildWeeklyDigestEmail(buildPayload({
      days: days([6.2, null, null, 2.0, 1.0, null, null]),
    }));
    expect(html).not.toContain('Too few worked days');
    expect(html).toContain('background:#171A20');
  });
});

describe('what finished and what carried', () => {
  it('names the project beside each finished task and marks it with the green check', () => {
    const { html } = buildWeeklyDigestEmail(buildPayload());
    expect(html).toContain('Rewrite onboarding email');
    expect(html).toContain('Northbridge');
    expect(html).toContain(`<span style="color:#3FBF7F;">&#10003;</span>`);
  });

  it('prints how many days each carried task has been open', () => {
    const { html } = buildWeeklyDigestEmail(buildPayload());
    expect(html).toContain('open 3 days');
  });

  it('says "open 1 day" rather than "1 days"', () => {
    const { html } = buildWeeklyDigestEmail(buildPayload({
      carried: [{ title: 'Thing', project: 'PORTA', seconds: 600, daysOpen: 1 }],
    }));
    expect(html).toContain('open 1 day<');
  });

  it('omits each block entirely when it has nothing in it', () => {
    const { html } = buildWeeklyDigestEmail(buildPayload({ finished: [], carried: [] }));
    expect(html).not.toContain('What you finished');
    expect(html).not.toContain('What carried');
  });

  it('leaves an untagged task unlabelled rather than calling it Untagged', () => {
    const { html } = buildWeeklyDigestEmail(buildPayload({
      finished: [{ title: 'Loose end', project: '', seconds: 600 }],
    }));
    // Scoped to the task block: "Untagged time is not shown" is the PROJECT note further down, and
    // that sentence is the whole point of the rule rather than a violation of it.
    const block = html.slice(html.indexOf('What you finished'), html.indexOf('What carried'));
    expect(block).toContain('Loose end');
    expect(block).not.toContain('Untagged');
    expect(block).not.toContain('Unnamed');
    // and no dangling separator where the project would have gone
    expect(block).not.toContain('Loose end<span style="color:#6F7885;">&nbsp;&middot;');
  });
});

describe('where the week went', () => {
  it('is by project, and says untagged time is not shown', () => {
    const { html } = buildWeeklyDigestEmail(buildPayload());
    expect(html).toContain('Where the week went');
    expect(html).toContain('By project. Untagged time is not shown.');
    expect(html).toContain('PORTA');
  });

  it('scales the bars against the top project', () => {
    const { html } = buildWeeklyDigestEmail(buildPayload({
      projects: [{ name: 'PORTA', seconds: 40000 }, { name: 'Admin', seconds: 10000 }],
    }));
    const section = html.slice(html.indexOf('Where the week went'));
    expect(section).toContain('width="25%"'); // 10000/40000
  });

  it('is omitted when there is no project time at all', () => {
    const { html } = buildWeeklyDigestEmail(buildPayload({ projects: [] }));
    expect(html).not.toContain('Where the week went');
  });

  it('never lists an app', () => {
    // Apps stay on the daily. A week's app split says nothing anyone can act on.
    const { html } = buildWeeklyDigestEmail(buildPayload());
    expect(html).not.toContain('Where your time went');
    expect(html).not.toContain('What pulled you off');
  });
});

describe('Ari\'s take', () => {
  it('renders the drafted take in the serif voice', () => {
    const { html } = buildWeeklyDigestEmail(buildPayload({ ariTake: 'A sentence about the week.' }));
    expect(html).toContain('A sentence about the week.');
    expect(html).toContain('Georgia');
  });

  it('says it cannot see an outcome rather than inventing one, when nothing closed or carried', () => {
    const { html } = buildWeeklyDigestEmail(buildPayload({
      ariTake: null, finished: [], carried: [],
    }));
    expect(html).toContain(NO_TAKE_LINE);
  });

  it('omits the section rather than guessing when there were outcomes but no take', () => {
    const { html } = buildWeeklyDigestEmail(buildPayload({ ariTake: null }));
    expect(html).not.toContain("Ari's take");
    expect(html).not.toContain(NO_TAKE_LINE);
  });
});

// ── The Gmail iOS lesson, as tests ────────────────────────────────────────────────────────────
// Every one of these guards the failure fixed on the daily on 2026-08-25 (6033838): attributes and
// table-layout:fixed are dropped, and anything whose size lived only there collapses.

describe('it survives a client that drops attributes', () => {
  it('states every column width in an inline style as well as an attribute', () => {
    const { html } = buildWeeklyDigestEmail(buildPayload());
    const withAttr = [...html.matchAll(/<td width="(\d+)%"([^>]*)>/g)];
    expect(withAttr.length).toBeGreaterThan(10);
    for (const [, pct, rest] of withAttr) {
      expect(rest).toContain(`width:${pct}%`);
    }
  });

  it('states every bar height in an inline style as well as an attribute', () => {
    const { html } = buildWeeklyDigestEmail(buildPayload());
    const bars = [...html.matchAll(/<td height="(\d+)"([^>]*)>/g)];
    expect(bars.length).toBeGreaterThan(6);
    for (const [, px, rest] of bars) {
      expect(rest).toContain(`height:${px}px`);
    }
  });

  it('never pins the card to a fixed pixel width', () => {
    const { html } = buildWeeklyDigestEmail(buildPayload());
    expect(html).toContain('width:100%;max-width:600px');
    expect(html).not.toContain('width:600px;max-width:600px');
  });

  it('gives the button its width inline so it cannot shrink to its text', () => {
    const { html } = buildWeeklyDigestEmail(buildPayload());
    const btn = html.slice(html.indexOf('Open Ari') - 500, html.indexOf('Open Ari') + 20);
    expect(btn).toContain('display:block;width:100%');
  });

  it('keeps every fix in the base layout, with the media query touching padding only', () => {
    const { html } = buildWeeklyDigestEmail(buildPayload());
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    // Every declaration inside the block must be a padding one. The media QUERY names a width, of
    // course; what matters is that nothing structural is declared in the rule body.
    const body = style.slice(style.indexOf('{', style.indexOf('@media')));
    const declarations = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    expect(declarations.length).toBeGreaterThan(0);
    for (const prop of declarations) {
      expect(prop).toMatch(/^padding-(left|right)$/);
    }
  });
});

describe('the green rule', () => {
  it('uses the accent for finished work, the day bars and the button — and nothing else', () => {
    const { html } = buildWeeklyDigestEmail(buildPayload());
    const uses = [...html.matchAll(/#3FBF7F/g)].length;
    // check + 6 day bars + 2 project bars + button = every one of them is work that counted
    expect(uses).toBeGreaterThan(5);
    // never behind body copy or a label
    expect(html).not.toMatch(/color:#3FBF7F;">(?!&#10003;)/);
  });
});

describe('the week range', () => {
  it('reads as a person would say it', () => {
    expect(formatWeekRange('2026-08-17', '2026-08-23')).toBe('Mon 17 – Sun 23 August 2026');
  });

  it('names both months when the week straddles one', () => {
    expect(formatWeekRange('2026-08-31', '2026-09-06')).toBe('Mon 31 August – Sun 6 September 2026');
  });

  it('falls back to the raw dates rather than inventing a format', () => {
    expect(formatWeekRange('not-a-date', 'also-not')).toBe('not-a-date – also-not');
  });
});

describe('the subject', () => {
  it('leads with the score when there was a plan', () => {
    const { subject } = buildWeeklyDigestEmail(buildPayload());
    expect(subject).toBe('Your week: 11 of 18 finished — Mon 17 – Sun 23 August 2026');
  });

  it('does not imply a score when nothing was planned', () => {
    const { subject } = buildWeeklyDigestEmail(buildPayload({ plannedCount: 0, finishedCount: 0 }));
    expect(subject).toBe('Your week — Mon 17 – Sun 23 August 2026');
  });
});
