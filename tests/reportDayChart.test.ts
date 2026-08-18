import { describe, expect, it } from 'vitest';
import { buildReportPage, type ReportDay, type ReportPage } from '../src/core/reportPageBuilder.js';

/**
 * 2026-08-18. The day chart disagreed with the rest of the report, and a client could see it.
 *
 * Each day's total was computed from its per-task split. That split comes from a grain that only
 * began recording on 17 August 2026, so every earlier day summed to zero and drew as a gap while
 * the table beside it showed real hours. Observed live: 6.1h in the table against an empty column.
 *
 * Every phase 2a fixture built the total and the split from the same numbers, which is exactly why
 * this survived. These tests deliberately do not.
 */

function page(days: ReportDay[], overrides: Partial<ReportPage> = {}): ReportPage {
  return {
    projectName: 'Test project',
    period: '13 – 18 August 2026',
    preparedBy: 'Yadin',
    sentOn: 'Sent 18 Aug 2026',
    summary: 'A summary.',
    tasks: [
      { label: 'Task one', status: 'in_progress', hours: 8.1, colourSlot: 1, result: 'r', dates: 'from 13 Aug' },
      { label: 'Task two', status: 'done', hours: 2.6, colourSlot: 2, result: 'r', dates: '17 Aug' }
    ],
    days,
    nextSteps: [],
    ...overrides
  };
}

/** Pull each column's printed total, in order, from the rendered page. */
function printedTotals(html: string): string[] {
  return [...html.matchAll(/<div class="coltot"[^>]*>([^<]*)<\/div>/g)].map((m) => m[1]!.trim());
}

function columnCount(html: string): number {
  return [...html.matchAll(/<div class="colwrap">/g)].length;
}

const noSplit = (label: string, hours: number): ReportDay => ({ label, hours, segments: [] });

describe('the day chart against the rest of the report', () => {
  it('draws a day that has hours but no per-task split', () => {
    const html = buildReportPage(
      page([
        noSplit('13 Aug', 6.1),
        noSplit('14 Aug', 2.0),
        { label: '17 Aug', hours: 2.6, segments: [{ taskLabel: 'Task two', colourSlot: 2, hours: 2.6 }] }
      ])
    );

    // The bug: these two rendered as gaps, as if the days were not worked.
    expect(printedTotals(html)).toEqual(['6.1h', '2.0h', '2.6h']);
    // No gap element: the flat-line marker, not the sentence, which explains gaps either way.
    expect(html).not.toMatch(/class="zero"/);
  });

  it('keeps a genuinely unworked day as a gap', () => {
    const html = buildReportPage(
      page([noSplit('13 Aug', 6.1), noSplit('14 Aug', 0), noSplit('15 Aug', 2.0), noSplit('16 Aug', 2.1)])
    );

    // Zero hours is the ONLY thing that makes a gap. Days not worked are never removed.
    expect(printedTotals(html)).toEqual(['6.1h', '&mdash;', '2.0h', '2.1h']);
    expect(html).toMatch(/class="zero"/);
    expect(columnCount(html)).toBe(4);
  });

  it('draws a partly attributed day at its own total, not at the split', () => {
    const html = buildReportPage(
      page([
        noSplit('13 Aug', 6.1),
        noSplit('14 Aug', 2.0),
        // 2.6h measured, only 0.7h of it attributed to a task. This is the live 17 August case.
        { label: '17 Aug', hours: 2.6, segments: [{ taskLabel: 'Task two', colourSlot: 2, hours: 0.7 }] }
      ])
    );

    expect(printedTotals(html)).toContain('2.6h');
    expect(printedTotals(html)).not.toContain('0.7h');
    // The remainder is shown as unrecorded rather than being credited to the one known task.
    expect(html).toContain('split not recorded');
    expect(html).toContain('17 Aug · 1.9h · split not recorded');
  });

  it('does not label a fully attributed day as unrecorded', () => {
    const html = buildReportPage(
      page([
        noSplit('13 Aug', 6.1),
        noSplit('14 Aug', 2.0),
        {
          label: '18 Aug',
          hours: 2.1,
          segments: [
            { taskLabel: 'Task one', colourSlot: 1, hours: 1.3 },
            { taskLabel: 'Task two', colourSlot: 2, hours: 0.8 }
          ]
        }
      ])
    );

    // Scoped to the day in question: 13 and 14 Aug have no split at all and rightly say so.
    expect(html).not.toMatch(/18 Aug · [^"]*split not recorded/);
    expect(html).toContain('13 Aug · 6.1h · split not recorded');
  });

  it('counts worked days for the thin-week rule from hours, not from the split', () => {
    // Four worked days, only one of which has a split. Counted from the split this saw one day,
    // dropped below the threshold and replaced a worked week with a sentence.
    const html = buildReportPage(
      page([
        noSplit('13 Aug', 6.1),
        noSplit('14 Aug', 2.0),
        noSplit('15 Aug', 0),
        { label: '18 Aug', hours: 2.1, segments: [{ taskLabel: 'Task one', colourSlot: 1, hours: 2.1 }] }
      ])
    );

    expect(html).toContain('Each day split by the task worked on');
    expect(html).not.toMatch(/across \d+ days —/);
  });

  it('still falls back to a sentence on a genuinely thin week', () => {
    const html = buildReportPage(page([noSplit('13 Aug', 6.1), noSplit('14 Aug', 0), noSplit('15 Aug', 0)]));

    expect(html).toContain('worked on 13 Aug');
    expect(html).not.toContain('Each day split by the task worked on');
  });

  it('counts the days-worked headline from hours, not from the split', () => {
    const html = buildReportPage(
      page([noSplit('13 Aug', 6.1), noSplit('14 Aug', 2.0), noSplit('15 Aug', 0), noSplit('16 Aug', 2.1)])
    );

    // Three days have hours. The headline said 1 when it counted splits.
    expect(html).toContain('across 3 days');
  });

  it('explains the pale band in words, only when there is one', () => {
    const withGap = buildReportPage(
      page([noSplit('13 Aug', 6.1), noSplit('14 Aug', 2.0), noSplit('15 Aug', 2.0)])
    );
    const withoutGap = buildReportPage(
      page([
        { label: '16 Aug', hours: 2.0, segments: [{ taskLabel: 'Task one', colourSlot: 1, hours: 2.0 }] },
        { label: '17 Aug', hours: 1.0, segments: [{ taskLabel: 'Task one', colourSlot: 1, hours: 1.0 }] },
        { label: '18 Aug', hours: 1.0, segments: [{ taskLabel: 'Task two', colourSlot: 2, hours: 1.0 }] }
      ])
    );

    // Nothing about this chart may rest on colour alone.
    expect(withGap).toContain('Paler sections are hours that were measured without a per-task breakdown');
    expect(withoutGap).not.toContain('Paler sections');
  });

  it('draws unrecorded time in its own tone, not the Other tone', () => {
    const html = buildReportPage(
      page([
        noSplit('13 Aug', 6.1),
        noSplit('14 Aug', 2.0),
        // One folded task plus a remainder: the two must not be the same colour, or they read as
        // a single band and the reader cannot tell measured-and-folded from never-recorded.
        { label: '17 Aug', hours: 2.6, segments: [{ taskLabel: 'Odd one', colourSlot: 0, hours: 0.7 }] }
      ])
    );

    expect(html).toContain('background:#e1e0d9');
    expect(html).toContain('background:#c3c2b7');
  });
});
