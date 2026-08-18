import { describe, expect, it } from 'vitest';
import { shortDayLabel } from '../src/api/controllers/reportsController.js';
import { buildReportPage, type ReportPage } from '../src/core/reportPageBuilder.js';

/**
 * 2026-08-18. Day labels reached the page as "2026-08-12" instead of "12 Aug".
 *
 * Seven ten-character labels, set not to wrap, overflowed the chart row on a phone and were
 * clipped, so the report appeared cut off. The long form was also wrong on a desktop, which is why
 * it is fixed at the source rather than hidden behind a media query.
 */
describe('short day labels', () => {
  it('turns a plain local date into the mockup form', () => {
    expect(shortDayLabel('2026-08-12')).toBe('12 Aug');
    expect(shortDayLabel('2026-01-01')).toBe('1 Jan');
    expect(shortDayLabel('2026-12-31')).toBe('31 Dec');
  });

  it('never travels through a timezone', () => {
    // new Date('2026-08-12') is midnight UTC; read back as a local day west of Greenwich it is the
    // 11th. The date was recorded in the user's own local time, so it must not be re-interpreted.
    expect(shortDayLabel('2026-08-12')).toBe('12 Aug');
    expect(shortDayLabel('2026-03-01')).toBe('1 Mar');
  });

  it('passes anything that is not a plain date straight through', () => {
    expect(shortDayLabel('12 Aug')).toBe('12 Aug');
    expect(shortDayLabel('')).toBe('');
    expect(shortDayLabel('week 3')).toBe('week 3');
    expect(shortDayLabel('2026-13-01')).toBe('2026-13-01');
  });

  it('keeps the label short everywhere it is used on the page', () => {
    const page: ReportPage = {
      projectName: 'Test',
      period: '12 – 14 August 2026',
      preparedBy: 'Yadin',
      sentOn: 'Sent 18 Aug 2026',
      summary: 's',
      tasks: [{ label: 'Task one', status: 'done', hours: 2, colourSlot: 1, result: 'r', dates: 'd' }],
      days: [
        { label: shortDayLabel('2026-08-12'), hours: 1, segments: [{ taskLabel: 'Task one', colourSlot: 1, hours: 1 }] },
        { label: shortDayLabel('2026-08-13'), hours: 0, segments: [] },
        { label: shortDayLabel('2026-08-14'), hours: 1, segments: [{ taskLabel: 'Task one', colourSlot: 1, hours: 1 }] },
        { label: shortDayLabel('2026-08-15'), hours: 1, segments: [{ taskLabel: 'Task one', colourSlot: 1, hours: 1 }] }
      ],
      nextSteps: []
    };
    const html = buildReportPage(page);

    // Column labels, the gap tooltip and the segment tooltips all read from the same label.
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(html).toContain('>12 Aug<');
    expect(html).toContain('13 Aug · no work on this project');
    expect(html).toContain('14 Aug · Task one');
  });

  it('keeps the thin-week sentence short too', () => {
    const page: ReportPage = {
      projectName: 'Test',
      period: '12 – 14 August 2026',
      preparedBy: 'Yadin',
      sentOn: 'Sent 18 Aug 2026',
      summary: 's',
      tasks: [{ label: 'Task one', status: 'done', hours: 2, colourSlot: 1, result: 'r', dates: 'd' }],
      days: [
        { label: shortDayLabel('2026-08-12'), hours: 1.3, segments: [] },
        { label: shortDayLabel('2026-08-13'), hours: 0, segments: [] },
        { label: shortDayLabel('2026-08-14'), hours: 0, segments: [] }
      ],
      nextSteps: []
    };

    // This sentence is what a client actually read: "across 2 days — 2026-08-17 (0.7h) and …".
    expect(buildReportPage(page)).toContain('worked on 12 Aug');
    expect(buildReportPage(page)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe('the chart at phone width', () => {
  const page: ReportPage = {
    projectName: 'Test',
    period: '12 – 18 August 2026',
    preparedBy: 'Yadin',
    sentOn: 'Sent 18 Aug 2026',
    summary: 's',
    tasks: [{ label: 'Task one', status: 'done', hours: 3, colourSlot: 1, result: 'r', dates: 'd' }],
    days: Array.from({ length: 7 }, (_, i) => ({
      label: shortDayLabel(`2026-08-${String(12 + i).padStart(2, '0')}`),
      hours: 1,
      segments: [{ taskLabel: 'Task one', colourSlot: 1, hours: 1 }]
    })),
    nextSteps: []
  };

  it('gives the chart a scroll container so a long range can never be clipped', () => {
    const html = buildReportPage(page);

    // The chart row previously had no way to overflow except off the edge of the page.
    expect(html).toContain('class="colsWrap"');
    expect(html).toMatch(/\.colsWrap\{[^}]*overflow-x:auto/);
  });

  it('actually adjusts the chart inside the phone breakpoint', () => {
    const html = buildReportPage(page);
    const start = html.indexOf('@media (max-width:640px)');
    const block = html.slice(start, html.indexOf('</style>', start));

    expect(start).toBeGreaterThan(-1);
    // The original breakpoint changed page padding and never touched the chart, which is how the
    // clipping went unnoticed. These three are the ones that make a week fit.
    expect(block).toMatch(/\.cols\{/);
    expect(block).toMatch(/\.collab\{/);
    expect(block).toMatch(/\.colsWrap\{/);
  });

  it('wraps the table so an extra column would scroll rather than break the page', () => {
    expect(buildReportPage(page)).toContain('class="tablewrap"');
  });
});
