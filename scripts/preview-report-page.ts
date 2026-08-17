/**
 * Phase 2a (2026-08-17) — the report page preview harness.
 *
 * Same idea as the check-in card harness and the Reports-page harness in the agent, and for the
 * same reason: the trap is building for a week and then discovering the report reads badly. This
 * renders the real renderer from fixtures, so a design change takes minutes instead of waiting for
 * real hours to accumulate.
 *
 *   npm run preview:report          writes the five states and prints the folder
 *   npm run preview:report -- --open   also opens them in the default browser
 *
 * FIVE STATES, NOT ONE, because the ugly cases are where this fails. State 5 matters most: it is
 * what the report looks like when the user does not play along, and it still has to be sendable
 * and still has to look deliberate.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildReportPage, type ReportPage, type ReportDay } from '../src/core/reportPageBuilder.js';

/** Build a day column from (task label, slot, hours) triples. */
function day(label: string, ...segs: Array<[string, number, number]>): ReportDay {
  return { label, segments: segs.map(([taskLabel, colourSlot, hours]) => ({ taskLabel, colourSlot, hours })) };
}

// ── 1. A FULL WEEK ─────────────────────────────────────────────────────────────────────────────
// The mockup's own shape: four tasks, a completed pair, one in progress, one blocked, two days
// not worked. This is the state the design was agreed against, so it is the regression baseline.
const fullWeek: ReportPage = {
  projectName: 'Porta',
  period: '12 – 17 August 2026',
  periodNote: 'week 3',
  preparedBy: 'Yadin',
  sentOn: 'Sent 17 Aug 2026',
  summary:
    'Client reports can now be drafted, previewed and sent end to end, which was the last remaining ' +
    'piece of the reporting flow. Sending runs server-side, so no mail credentials sit on the machine. ' +
    'The tasks page is underway. One item is waiting on you: which figures should appear in the client ' +
    'view. Nothing further can be built on that until it is decided.',
  tasks: [
    {
      label: 'Report sending, end to end', status: 'done', hours: 6.2, colourSlot: 1,
      result: 'A report can be drafted, previewed exactly as you will receive it, and sent. Sending runs on the server so no mail credentials sit on the machine.',
      dates: '14 – 17 Aug'
    },
    {
      label: 'Weekly digest email', status: 'done', hours: 3.4, colourSlot: 2,
      result: "Redesigned and shipped. Goes out nightly with the day's work and a link back into the app.",
      dates: '12 Aug'
    },
    {
      label: 'Tasks page', status: 'in_progress', hours: 2.8, colourSlot: 3,
      result: 'Layout and filters are done. Editing and status changes still to wire up. Expected to finish 19 Aug.',
      dates: 'started 17 Aug'
    },
    {
      label: 'Project page figures', status: 'blocked', hours: 1.1, colourSlot: 4,
      result: 'Waiting on a decision about which figures appear in the client view. Work is paused until that is settled.',
      dates: 'held since 15 Aug',
      blockedReason: 'Needs your decision'
    }
  ],
  days: [
    day('12 Aug', ['Weekly digest email', 2, 3.4]),
    day('13 Aug'),
    day('14 Aug', ['Report sending, end to end', 1, 1.8]),
    day('15 Aug', ['Report sending, end to end', 1, 2.4], ['Project page figures', 4, 1.1]),
    day('16 Aug'),
    day('17 Aug', ['Report sending, end to end', 1, 2.0], ['Tasks page', 3, 2.8])
  ],
  nextSteps: [
    'Finish the tasks page, including editing and status changes.',
    'Wire task status through to the report so it updates itself.',
    'Agree the project page figures so that work can restart.'
  ]
};

// ── 2. A THIN WEEK ─────────────────────────────────────────────────────────────────────────────
// Two tasks, 3.7 hours, ONE day worked. This is what a real first report looks like, and the test
// is that it does not look broken or apologetic — a single column is a fact, not a failure.
const thinWeek: ReportPage = {
  projectName: 'Nolan Studio',
  period: '11 – 17 August 2026',
  preparedBy: 'Yadin',
  sentOn: 'Sent 17 Aug 2026',
  summary:
    'A short week on this project. The brief is agreed and the first draft of the pricing page is ' +
    'written; the rest of the week went to other work.',
  tasks: [
    {
      label: 'Pricing page — first draft', status: 'done', hours: 2.0, colourSlot: 1,
      result: 'Draft written and sent for review.',
      dates: '14 Aug'
    },
    {
      label: 'Brief and scope', status: 'done', hours: 1.7, colourSlot: 2,
      result: 'Agreed in writing, including what is out of scope.',
      dates: '14 Aug'
    }
  ],
  days: [
    day('11 Aug'), day('12 Aug'), day('13 Aug'),
    day('14 Aug', ['Pricing page — first draft', 1, 2.0], ['Brief and scope', 2, 1.7]),
    day('15 Aug'), day('16 Aug'), day('17 Aug')
  ],
  nextSteps: ['Review comments on the pricing page and revise.']
};

// ── 3. A CROWDED PROJECT ───────────────────────────────────────────────────────────────────────
// Twelve tasks. Slots 1-8 keep their own colour; the four created ninth and later hold slot 0 and
// fold into one neutral Other slice in BOTH charts — while the table below still lists every one of
// them by name with its own hours. That split is the whole agreement.
const crowded: ReportPage = {
  projectName: 'Meridian Rebuild',
  period: '4 – 17 August 2026',
  periodNote: 'weeks 1–2',
  preparedBy: 'Yadin',
  sentOn: 'Sent 17 Aug 2026',
  summary:
    'Two weeks across the rebuild. The data layer and the auth flow are done, the dashboard and the ' +
    'billing screens are in progress, and the export job is held pending the schema decision.',
  tasks: [
    { label: 'Data layer migration', status: 'done', hours: 9.4, colourSlot: 1, result: 'All tables migrated with no downtime.', dates: '4 – 7 Aug' },
    { label: 'Auth flow rewrite', status: 'done', hours: 7.1, colourSlot: 2, result: 'Sign-in, reset and session handling replaced.', dates: '5 – 9 Aug' },
    { label: 'Dashboard shell', status: 'in_progress', hours: 6.3, colourSlot: 3, result: 'Layout and navigation done, widgets remaining.', dates: 'from 10 Aug' },
    { label: 'Billing screens', status: 'in_progress', hours: 5.2, colourSlot: 4, result: 'Plan picker built; invoice history still to do.', dates: 'from 12 Aug' },
    { label: 'Export job', status: 'blocked', hours: 3.8, colourSlot: 5, result: 'Paused until the schema question is settled.', dates: 'held since 13 Aug', blockedReason: 'Waiting on schema decision' },
    { label: 'Search indexing', status: 'done', hours: 3.1, colourSlot: 6, result: 'Index rebuilt nightly and query times halved.', dates: '8 Aug' },
    { label: 'Email templates', status: 'done', hours: 2.6, colourSlot: 7, result: 'All six transactional emails redesigned.', dates: '11 Aug' },
    { label: 'Error reporting', status: 'done', hours: 2.2, colourSlot: 8, result: 'Crashes now grouped and alerting works.', dates: '6 Aug' },
    { label: 'Accessibility pass', status: 'done', hours: 1.9, colourSlot: 0, result: 'Contrast and focus order fixed across the app.', dates: '15 Aug' },
    { label: 'Mobile breakpoints', status: 'in_progress', hours: 1.4, colourSlot: 0, result: 'Two of five screens adapted.', dates: 'from 16 Aug' },
    { label: 'Analytics events', status: 'done', hours: 1.1, colourSlot: 0, result: 'Twelve events instrumented and verified.', dates: '14 Aug' },
    { label: 'Docs and handover notes', status: 'planned', hours: 0.6, colourSlot: 0, result: 'Outline started.', dates: 'from 17 Aug' }
  ],
  days: [
    day('4 Aug', ['Data layer migration', 1, 4.6]),
    day('5 Aug', ['Data layer migration', 1, 2.4], ['Auth flow rewrite', 2, 2.2]),
    day('6 Aug', ['Auth flow rewrite', 2, 2.9], ['Error reporting', 8, 2.2]),
    day('7 Aug', ['Data layer migration', 1, 2.4]),
    day('8 Aug', ['Search indexing', 6, 3.1], ['Auth flow rewrite', 2, 1.0]),
    day('9 Aug', ['Auth flow rewrite', 2, 1.0]),
    day('10 Aug', ['Dashboard shell', 3, 3.4]),
    day('11 Aug', ['Email templates', 7, 2.6], ['Dashboard shell', 3, 1.4]),
    day('12 Aug', ['Billing screens', 4, 2.8], ['Dashboard shell', 3, 1.5]),
    day('13 Aug', ['Export job', 5, 3.8]),
    day('14 Aug', ['Billing screens', 4, 2.4], ['Analytics events', 0, 1.1]),
    day('15 Aug', ['Accessibility pass', 0, 1.9]),
    day('16 Aug', ['Mobile breakpoints', 0, 1.4]),
    day('17 Aug', ['Docs and handover notes', 0, 0.6])
  ],
  nextSteps: [
    'Finish the dashboard widgets.',
    'Settle the export schema so that job can restart.',
    'Complete the remaining mobile breakpoints.'
  ]
};

// ── 4. EVERYTHING COMPLETE ─────────────────────────────────────────────────────────────────────
// Nothing in progress, nothing blocked. Those two groups disappear entirely rather than showing an
// empty heading, and the blocked figure reads in ordinary ink because a zero there is good news.
const allDone: ReportPage = {
  projectName: 'Harbour Identity',
  period: '11 – 15 August 2026',
  preparedBy: 'Yadin',
  sentOn: 'Sent 15 Aug 2026',
  summary:
    'Everything scoped for this phase is finished. The mark, the type system and the guidelines are ' +
    'delivered, and the asset pack is with your team.',
  tasks: [
    { label: 'Logo and mark', status: 'done', hours: 5.4, colourSlot: 1, result: 'Final mark delivered in all formats.', dates: '11 – 12 Aug' },
    { label: 'Type and colour system', status: 'done', hours: 4.1, colourSlot: 2, result: 'Scale, weights and palette documented.', dates: '13 Aug' },
    { label: 'Brand guidelines', status: 'done', hours: 3.6, colourSlot: 3, result: 'Twenty page PDF covering usage and spacing.', dates: '14 Aug' },
    { label: 'Asset pack', status: 'done', hours: 2.0, colourSlot: 4, result: 'SVG, PNG and favicon sets handed over.', dates: '15 Aug' }
  ],
  days: [
    day('11 Aug', ['Logo and mark', 1, 3.0]),
    day('12 Aug', ['Logo and mark', 1, 2.4]),
    day('13 Aug', ['Type and colour system', 2, 4.1]),
    day('14 Aug', ['Brand guidelines', 3, 3.6]),
    day('15 Aug', ['Asset pack', 4, 2.0])
  ],
  nextSteps: []
};

// ── 5. EVERY RESULT LINE SKIPPED ───────────────────────────────────────────────────────────────
// THE ONE THAT MATTERS MOST. Hours and names and nothing else. No placeholder, no apology, no
// "no result recorded" — the sentence is simply absent and the rows close up. The summary is also
// empty, because a user who skips every line is unlikely to write a paragraph either.
const noResults: ReportPage = {
  projectName: 'Kestrel Consulting',
  period: '11 – 17 August 2026',
  preparedBy: 'Yadin',
  sentOn: 'Sent 17 Aug 2026',
  summary: '',
  tasks: [
    { label: 'Quarterly figures review', status: 'done', hours: 4.6, colourSlot: 1, result: '', dates: '12 – 13 Aug' },
    { label: 'Board pack', status: 'done', hours: 3.9, colourSlot: 2, result: '', dates: '14 Aug' },
    { label: 'Forecast model', status: 'in_progress', hours: 3.2, colourSlot: 3, result: '', dates: 'from 16 Aug' },
    { label: 'Supplier contracts', status: 'blocked', hours: 1.4, colourSlot: 4, result: '', dates: 'held since 15 Aug' }
  ],
  days: [
    day('11 Aug'),
    day('12 Aug', ['Quarterly figures review', 1, 2.4]),
    day('13 Aug', ['Quarterly figures review', 1, 2.2]),
    day('14 Aug', ['Board pack', 2, 3.9]),
    day('15 Aug', ['Supplier contracts', 4, 1.4]),
    day('16 Aug', ['Forecast model', 3, 1.8]),
    day('17 Aug', ['Forecast model', 3, 1.4])
  ],
  nextSteps: []
};

const STATES: Array<{ file: string; title: string; page: ReportPage }> = [
  { file: '1-full-week.html', title: 'A full week — four tasks, two days not worked', page: fullWeek },
  { file: '2-thin-week.html', title: 'A thin week — two tasks, 3.7h, one day worked', page: thinWeek },
  { file: '3-crowded.html', title: 'A crowded project — twelve tasks, four folded into Other', page: crowded },
  { file: '4-all-complete.html', title: 'Everything complete — no in-progress, nothing blocked', page: allDone },
  { file: '5-no-result-lines.html', title: 'Every result line skipped — hours and names only', page: noResults }
];

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dir = join(tmpdir(), 'porta-report-page-preview', stamp);
mkdirSync(dir, { recursive: true });

for (const state of STATES) {
  const html = buildReportPage(state.page);
  const path = join(dir, state.file);
  writeFileSync(path, html, 'utf8');
  console.log(`  ${state.file.padEnd(24)} ${state.title}`);
}

console.log('');
console.log(`${STATES.length} states written to:`);
console.log(dir);

if (process.argv.includes('--open')) {
  for (const state of STATES) {
    execFile('cmd', ['/c', 'start', '', join(dir, state.file)], () => {});
  }
}
