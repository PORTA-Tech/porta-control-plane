// The WEEKLY digest — Chat 8 item 1, built to `Ari_Weekly_Digest_Mockup.html` (agreed 2026-08-25).
//
// The daily answers "how did today go". The weekly answers "did the week go where I meant it to",
// so it is built from DAYS and PROJECTS rather than from hours and apps. Every design value comes
// from digestEmailBuilder rather than being restated here: the green rule only holds if there is
// one definition of the green.
//
// ── Why every width is stated inline ──────────────────────────────────────────────────────────
// Gmail iOS drops width ATTRIBUTES and ignores `table-layout:fixed`. On the daily that turned the
// axis into "9am1236911pm", collapsed the bars to nothing, and shrank the button to a 53px box; and
// because each bar's proportion lived only in its attribute, the two halves split 50/50 and every
// bar rendered exactly half full regardless of the number beside it. Fixed 2026-08-25 (6033838).
// This file is written to that lesson from the start: every column and every bar states its size in
// an inline style AS WELL AS the attribute, so nothing depends on either surviving.

import {
  ACCENT,
  ACCENT_TEXT,
  BODY,
  CARD_BG,
  escapeHtml,
  fmtMinutes,
  GAP_TRACK,
  HAIRLINE,
  HEADLINE,
  META,
  MUTED,
  PAGE_BG,
  SANS,
  SERIF,
} from './digestEmailBuilder.js';

// ── Payload ───────────────────────────────────────────────────────────────────────────────────
//
// THIS IS A CONTRACT THE AGENT MUST FILL. None of the task or project fields below can be derived
// on the server: `daily_stats` holds per-day metrics only, and there is no task store and no
// project store anywhere in this repo. See the handover note — the weekly cannot send until the
// agent posts this.

/** One of the seven days. `worked` is authoritative: a day can be worked and still have no focus. */
export interface WeeklyDayEntry {
  /** 'YYYY-MM-DD' local. */
  dateLocal: string;
  /** Three letters as the email prints them: Mon, Tue... The server never guesses a locale. */
  label: string;
  focusSeconds: number;
  /**
   * Whether the day was worked AT ALL. Deliberately separate from `focusSeconds > 0`: a day with
   * tracked time but no focused stretch is a worked day that reads as a very short bar, and a day
   * the machine was off is an empty track. Collapsing the two would draw a gap as a bad day.
   */
  worked: boolean;
}

/** A task that closed inside the week. */
export interface WeeklyFinishedEntry {
  title: string;
  /** The project it was tagged to. Empty = untagged, and untagged work is NOT shown (see below). */
  project: string;
  seconds: number;
}

/** A task still open at the end of the week. `daysOpen` is the whole point of the block. */
export interface WeeklyCarriedEntry {
  title: string;
  project: string;
  seconds: number;
  /**
   * How many days this has been open. It is the only number that separates STUCK from SLOW, which
   * is why "What carried" exists as its own block rather than as a grey half of "What finished".
   */
  daysOpen: number;
}

/** Measured time against one project across the week. */
export interface WeeklyProjectEntry {
  name: string;
  seconds: number;
}

/** A metric whose source had no data. Rendered as "no data", never as a confident zero. */
export type WeeklyMissingField = 'focus' | 'away' | 'tracked' | 'bestDay';

export interface WeeklyDigestPayload {
  accountId?: string | null;
  deviceId: string;
  machineId: string;
  /** 'YYYY-MM-DD' — the Monday. */
  weekStartLocal: string;
  /** 'YYYY-MM-DD' — the Sunday. */
  weekEndLocal: string;
  timezoneOffsetMinutes: number;
  reportedAtUtc: string;
  /**
   * Planned and finished across the week, scored through the SAME rule as the evening card and the
   * daily digest (UserCheckInTaskBoard.SummarizeDay: only state 'done' counts as finished). The
   * agent scores this, precisely so the weekly and the daily cannot disagree about what finished
   * means — which is the bug this section exists to avoid.
   */
  plannedCount: number;
  finishedCount: number;
  trackedSeconds: number;
  focusSeconds: number;
  awaySeconds: number;
  /** Exactly seven, Monday first. Fewer renders what is given; the strip never invents a day. */
  days: ReadonlyArray<WeeklyDayEntry>;
  finished: ReadonlyArray<WeeklyFinishedEntry>;
  carried: ReadonlyArray<WeeklyCarriedEntry>;
  projects: ReadonlyArray<WeeklyProjectEntry>;
  /** Ari's take, drafted from result lines and statuses only — never from app usage. */
  ariTake?: string | null;
  missingFields?: ReadonlyArray<WeeklyMissingField>;
}

// ── Shared shape ──────────────────────────────────────────────────────────────────────────────

/** The card's horizontal padding. The daily uses 32; the mockup for this one uses 20. */
const PAD_X = 20;

const LABEL = `font-size:10px;color:${META};text-transform:uppercase;padding-bottom:12px;`;
const NOTE = `font-size:11px;color:${META};padding-top:10px;`;
const ROW_TEXT = `font-size:13px;color:${BODY};`;

/** The 0.5px hairline between sections, at this card's padding. */
function rule(padTop = 20): string {
  return `<tr><td class="px" style="padding:${padTop}px ${PAD_X}px 0 ${PAD_X}px;">` +
    `<div style="height:0.5px;background:${HAIRLINE};font-size:0;line-height:0;">&nbsp;</div></td></tr>`;
}

/** Opens a section cell carrying its label. */
function sectionOpen(label: string, padTop = 18): string {
  return `<tr><td class="px" style="padding:${padTop}px ${PAD_X}px 0 ${PAD_X}px;">` +
    `<div style="${LABEL}">${escapeHtml(label)}</div>`;
}

const NO_DATA = `<span style="color:${META};font-size:15px;">no data</span>`;

/** "6.2h" — one decimal, always, for the day strip and the project split. */
function fmtHours1(seconds: number): string {
  return (seconds / 3600).toFixed(1) + 'h';
}

/** "8h" for a round figure, "6.2h" otherwise. What the best-day cell prints. */
function fmtHoursTrim(seconds: number): string {
  const h = seconds / 3600;
  return (Math.abs(h - Math.round(h)) < 0.05 ? String(Math.round(h)) : h.toFixed(1)) + 'h';
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];
/** "six worked days" reads as a sentence; "6 worked days" reads as a metric. */
function numberWord(n: number): string {
  return WORDS[n] ?? String(n);
}

/** "17 August" · "14 and 17 August" — a list a person would say aloud. Mirrors reportPageBuilder. */
function joinDays(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

// ── 1. Header and headline ────────────────────────────────────────────────────────────────────

function buildHeadHtml(p: WeeklyDigestPayload, range: string, missing: Set<WeeklyMissingField>): string {
  const workedDays = p.days.filter((d) => d.worked).length;

  // The resume. Planned and finished are the agent's own score, so this line and the daily's
  // cannot drift apart.
  const resume = `You planned ${p.plannedCount} ${p.plannedCount === 1 ? 'thing' : 'things'}.` +
    `<br>You finished ${p.finishedCount}.`;

  const context = missing.has('focus')
    ? `Focused time wasn't recorded this week.`
    : `${fmtMinutes(p.focusSeconds)} focused across ${numberWord(workedDays)} worked ` +
      `${workedDays === 1 ? 'day' : 'days'}.`;

  return `
<!-- 1 wordmark / eyebrow / range -->
<tr><td class="px" style="padding:22px ${PAD_X}px 0 ${PAD_X}px;">
  <div style="font-size:15px;font-weight:500;color:${HEADLINE};letter-spacing:-0.1px;">Ari <span style="color:${META};font-weight:400;">by Porta</span></div>
  <div style="font-size:10px;color:${META};text-transform:uppercase;padding-top:18px;">Your week at a glance</div>
  <div style="font-size:13px;color:${MUTED};padding-top:6px;">${escapeHtml(range)}</div>
</td></tr>

<!-- 2 the resume -->
<tr><td class="px" style="padding:20px ${PAD_X}px 0 ${PAD_X}px;">
  <div style="font-size:22px;color:${HEADLINE};line-height:1.25;">${resume}</div>
  <div style="font-size:13px;color:${MUTED};padding-top:8px;">${context}</div>
</td></tr>`;
}

// ── 2. The week ───────────────────────────────────────────────────────────────────────────────
//
// One bar per day, filled to focused time and scaled against the best day. A day not worked is an
// EMPTY TRACK, never a zero-height bar: a gap and a bad day are not the same thing, and the whole
// point of the strip is that you can tell them apart at a glance.

/** Below this many worked days the strip becomes a sentence. Same rule, and same number, as the
 *  client report (`reportPageBuilder.MIN_DAYS_FOR_CHART`): one tall column beside six flat lines
 *  reads as a chart that failed rather than as a short week. */
const MIN_DAYS_FOR_STRIP = 3;

/** The track's full height in px. The fill is a fraction of this, never below 2px when non-zero. */
const BAR_HEIGHT = 64;

function dayColumnHtml(day: WeeklyDayEntry, peakFocusSeconds: number, widthPct: number): string {
  // Email-safe vertical bar: the MOCKUP draws it with position:absolute, which Gmail strips
  // outright. Two stacked rows in a fixed-height table give the identical picture using nothing
  // but heights and backgrounds — and both rows carry their height inline as well as as an
  // attribute, so the bar keeps its proportion when the attributes are dropped.
  let fill = 0;
  if (day.worked && day.focusSeconds > 0 && peakFocusSeconds > 0) {
    fill = Math.round((day.focusSeconds / peakFocusSeconds) * BAR_HEIGHT);
    // Focused time that was measured must be visible. A 1px sliver still says "this happened".
    if (fill < 2) fill = 2;
    if (fill > BAR_HEIGHT) fill = BAR_HEIGHT;
  }
  const empty = BAR_HEIGHT - fill;

  const emptyRow = empty > 0
    ? `<tr><td height="${empty}" style="height:${empty}px;font-size:0;line-height:0;">&nbsp;</td></tr>`
    : '';
  const fillRow = fill > 0
    ? `<tr><td height="${fill}" style="height:${fill}px;background:${ACCENT};border-radius:3px;font-size:0;line-height:0;">&nbsp;</td></tr>`
    : '';

  // A day that was not worked prints an em dash rather than "0.0h": zero hours is a claim about
  // the day, and a machine that was off made no such claim.
  const value = day.worked
    ? `<div style="font-size:11px;color:${BODY};text-align:center;">${fmtHours1(day.focusSeconds)}</div>`
    : `<div style="font-size:11px;color:${META};text-align:center;">&mdash;</div>`;

  return `<td width="${widthPct}%" style="width:${widthPct}%;vertical-align:bottom;padding-right:4px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;height:${BAR_HEIGHT}px;background:${GAP_TRACK};border-radius:3px;">
          ${emptyRow}${fillRow}
        </table>
        <div style="font-size:10px;color:${META};text-transform:uppercase;text-align:center;padding-top:6px;">${escapeHtml(day.label)}</div>
        ${value}
      </td>`;
}

function buildWeekHtml(p: WeeklyDigestPayload): string {
  if (p.days.length === 0) return '';

  const worked = p.days.filter((d) => d.worked);

  // Too few worked days to draw a distribution. Every worked day is still NAMED, with its hours —
  // this replaces a chart, it does not hide anything.
  if (worked.length > 0 && worked.length < MIN_DAYS_FOR_STRIP) {
    const total = worked.reduce((s, d) => s + d.focusSeconds, 0);
    const sentence = worked.length === 1
      ? `${fmtMinutes(total)} focused, worked on ${escapeHtml(worked[0]!.label)}.`
      : `${fmtMinutes(total)} focused across ${numberWord(worked.length)} days — ` +
        `${joinDays(worked.map((d) => `${escapeHtml(d.label)} (${fmtHours1(d.focusSeconds)})`))}.`;
    return `
<!-- 3 the week, as a sentence -->
${sectionOpen('The week')}
  <div style="${ROW_TEXT}line-height:1.5;">${sentence}</div>
  <div style="${NOTE}">Too few worked days this week to draw a shape.</div>
</td></tr>
${rule()}`;
  }

  if (worked.length === 0) return '';

  const peak = Math.max(...p.days.map((d) => (d.worked ? d.focusSeconds : 0)), 0);
  const widthPct = Math.floor(100 / p.days.length);
  const columns = p.days.map((d) => dayColumnHtml(d, peak, widthPct)).join('\n      ');

  const notWorked = p.days.filter((d) => !d.worked).map((d) => d.label);
  const note = notWorked.length === 0
    ? 'Focused time each day.'
    : `Focused time each day. ${joinDays(notWorked.map(escapeHtml))} not worked.`;

  return `
<!-- 3 the week -->
${sectionOpen('The week')}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;table-layout:fixed;">
    <tr>
      ${columns}
    </tr>
  </table>
  <div style="${NOTE}">${note}</div>
</td></tr>
${rule()}`;
}

// ── 3 & 4. What you finished · What carried ───────────────────────────────────────────────────

/** The project suffix, quietly, after the title. Untagged work carries no suffix — it is never
 *  labelled "Untagged", because naming an absence implies it is a category. */
function projectSuffix(project: string): string {
  const p = project.trim();
  return p.length === 0 ? '' : `<span style="color:${META};">&nbsp;&middot;&nbsp;${escapeHtml(p)}</span>`;
}

function taskRowHtml(left: string, right: string, last: boolean): string {
  const pad = last ? '' : 'padding:0 0 9px 0;';
  return `  <tr><td style="${pad}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;table-layout:fixed;">
      <tr>
        <td width="78%" style="width:78%;padding-right:10px;${ROW_TEXT}word-break:break-word;">${left}</td>
        <td width="22%" align="right" style="width:22%;${ROW_TEXT}text-align:right;white-space:nowrap;vertical-align:top;">${right}</td>
      </tr>
    </table>
  </td></tr>`;
}

function buildFinishedHtml(p: WeeklyDigestPayload): string {
  if (p.finished.length === 0) return '';
  const rows = p.finished
    .map((t, i) => taskRowHtml(
      `<span style="color:${ACCENT};">&#10003;</span> ${escapeHtml(t.title)}${projectSuffix(t.project)}`,
      fmtMinutes(t.seconds),
      i === p.finished.length - 1))
    .join('\n');

  return `
<!-- 4 what you finished -->
${sectionOpen('What you finished')}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
${rows}
  </table>
</td></tr>`;
}

function buildCarriedHtml(p: WeeklyDigestPayload): string {
  if (p.carried.length === 0) return '';
  const rows = p.carried
    .map((t, i) => taskRowHtml(
      `${escapeHtml(t.title)}${projectSuffix(t.project)}` +
        `<div style="font-size:11px;color:${META};padding-top:2px;">open ${t.daysOpen} ${t.daysOpen === 1 ? 'day' : 'days'}</div>`,
      fmtMinutes(t.seconds),
      i === p.carried.length - 1))
    .join('\n');

  return `
<!-- 5 what carried -->
${sectionOpen('What carried', 16)}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
${rows}
  </table>
</td></tr>`;
}

// ── 5. The numbers ────────────────────────────────────────────────────────────────────────────

function figureCell(label: string, value: string, last: boolean): string {
  const gutter = last ? '' : 'padding-right:8px;';
  return `<td width="25%" style="width:25%;vertical-align:top;${gutter}">` +
    `<div style="font-size:10px;color:${META};text-transform:uppercase;padding-bottom:4px;">${escapeHtml(label)}</div>` +
    `<div style="font-size:15px;color:${HEADLINE};white-space:nowrap;">${value}</div></td>`;
}

function buildFiguresHtml(p: WeeklyDigestPayload, missing: Set<WeeklyMissingField>): string {
  // The best day is the day with the most FOCUSED time, named. "Thu 8h" says more than a bare
  // number because the thing worth knowing is which day it was.
  const workedDays = p.days.filter((d) => d.worked && d.focusSeconds > 0);
  let bestDay = NO_DATA;
  if (!missing.has('bestDay') && workedDays.length > 0) {
    const best = workedDays.reduce((a, b) => (b.focusSeconds > a.focusSeconds ? b : a));
    bestDay = `${escapeHtml(best.label)} ${fmtHoursTrim(best.focusSeconds)}`;
  }

  return `
<!-- 6 the numbers -->
<tr><td class="px" style="padding:18px ${PAD_X}px 0 ${PAD_X}px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;table-layout:fixed;">
    <tr>
      ${figureCell('Worked', missing.has('tracked') ? NO_DATA : fmtMinutes(p.trackedSeconds), false)}
      ${figureCell('Focused', missing.has('focus') ? NO_DATA : fmtMinutes(p.focusSeconds), false)}
      ${figureCell('Best day', bestDay, false)}
      ${figureCell('Away', missing.has('away') ? NO_DATA : fmtMinutes(p.awaySeconds), true)}
    </tr>
  </table>
</td></tr>
${rule()}`;
}

// ── 6. Where the week went ────────────────────────────────────────────────────────────────────
//
// BY PROJECT, never by app. On a single day the app split is a useful mirror; across a week it says
// nothing you can act on. Apps stay on the daily.
//
// Untagged time is NOT shown and NOT implied — same rule as the daily's residue: this is a ranking
// of where the week went, not an accounting of every minute, and the honest totals are in the four
// figures above.

function buildProjectsHtml(p: WeeklyDigestPayload): string {
  const projects = p.projects
    .filter((x) => x && x.name.trim().length > 0 && Number.isFinite(x.seconds) && x.seconds > 0)
    .slice(0, 6);
  if (projects.length === 0) return '';

  const top = Math.max(...projects.map((x) => x.seconds));
  const rows = projects
    .map((x, i) => {
      const last = i === projects.length - 1;
      const pad = last ? '' : 'padding-bottom:10px;';
      let width = Math.max(1, Math.round((x.seconds / top) * 100));
      const bar = width >= 100
        ? `<tr><td width="100%" style="width:100%;height:5px;background:${ACCENT};border-radius:3px;font-size:0;line-height:0;">&nbsp;</td></tr>`
        : `<tr><td width="${width}%" style="width:${width}%;height:5px;background:${ACCENT};border-radius:3px;font-size:0;line-height:0;">&nbsp;</td>` +
          `<td width="${100 - width}%" style="width:${100 - width}%;height:5px;font-size:0;line-height:0;">&nbsp;</td></tr>`;
      return `    <tr>
      <td width="36%" style="width:36%;padding-right:8px;${ROW_TEXT}word-break:break-word;${pad}">${escapeHtml(x.name)}</td>
      <td width="44%" style="width:44%;padding-right:8px;${pad}">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;table-layout:fixed;">
          ${bar}
        </table>
      </td>
      <td width="20%" align="right" style="width:20%;${ROW_TEXT}text-align:right;white-space:nowrap;${pad}">${fmtHours1(x.seconds)}</td>
    </tr>`;
    })
    .join('\n');

  return `
<!-- 7 where the week went -->
${sectionOpen('Where the week went')}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;table-layout:fixed;">
${rows}
  </table>
  <div style="font-size:11px;color:${META};padding-top:4px;">By project. Untagged time is not shown.</div>
</td></tr>
${rule()}`;
}

// ── 7. Ari's take ─────────────────────────────────────────────────────────────────────────────

export const NO_TAKE_LINE =
  "Ari can't see how the week's work ended, so there's nothing here it will guess at.";

function buildTakeHtml(body: string): string {
  return `
<!-- 8 Ari's take -->
${sectionOpen("Ari's take")}
  <div style="font-family:${SERIF};font-size:15px;line-height:1.6;color:${BODY};">
    ${escapeHtml(body).replace(/\n/g, '<br>')}
  </div>
</td></tr>`;
}

// ── Subject ───────────────────────────────────────────────────────────────────────────────────

export function buildWeeklySubject(p: WeeklyDigestPayload, range: string): string {
  if (p.plannedCount > 0) {
    return `Your week: ${p.finishedCount} of ${p.plannedCount} finished — ${range}`;
  }
  return `Your week — ${range}`;
}

/** "Mon 17 – Sun 23 August 2026". Falls back to the raw dates rather than inventing a format. */
export function formatWeekRange(startLocal: string, endLocal: string): string {
  try {
    const a = new Date(startLocal + 'T00:00:00');
    const b = new Date(endLocal + 'T00:00:00');
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return `${startLocal} – ${endLocal}`;
    const dow = (d: Date) => d.toLocaleDateString('en-GB', { weekday: 'short' });
    const sameMonth = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
    const month = b.toLocaleDateString('en-GB', { month: 'long' });
    if (sameMonth) {
      return `${dow(a)} ${a.getDate()} – ${dow(b)} ${b.getDate()} ${month} ${b.getFullYear()}`;
    }
    const aMonth = a.toLocaleDateString('en-GB', { month: 'long' });
    return `${dow(a)} ${a.getDate()} ${aMonth} – ${dow(b)} ${b.getDate()} ${month} ${b.getFullYear()}`;
  } catch {
    return `${startLocal} – ${endLocal}`;
  }
}

// ── Main builder ──────────────────────────────────────────────────────────────────────────────

export function buildWeeklyDigestEmail(
  p: WeeklyDigestPayload,
  launchUrl = 'porta://open'
): { subject: string; html: string } {
  const missing = new Set<WeeklyMissingField>(p.missingFields ?? []);
  const range = formatWeekRange(p.weekStartLocal, p.weekEndLocal);
  const subject = buildWeeklySubject(p, range);

  // With no outcome anywhere on the week there is nothing to write FROM, so the honest line goes in
  // rather than a sentence that would be true of any week.
  const take = (p.ariTake ?? '').trim();
  const takeBody = take.length > 0
    ? take
    : (p.finished.length > 0 || p.carried.length > 0 ? '' : NO_TAKE_LINE);
  const takeHtml = takeBody.length > 0 ? buildTakeHtml(takeBody) : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>Ari Weekly Digest</title>
<style>
  /* Enhancement ONLY. Every rule below is a nicety; the base layout above is what has to hold,
     because Gmail iOS on a non-Gmail account strips this block entirely. */
  @media only screen and (max-width:480px) {
    .px { padding-left:16px !important; padding-right:16px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${PAGE_BG};">
<div style="margin:0;padding:0;background:${PAGE_BG};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:${PAGE_BG};padding:32px 0;">
<tr><td align="center">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;margin:0 auto;background:${CARD_BG};border:0.5px solid ${HAIRLINE};border-radius:12px;font-family:${SANS};">
${buildHeadHtml(p, range, missing)}
${rule(20)}
${buildWeekHtml(p)}
${buildFinishedHtml(p)}
${buildCarriedHtml(p)}
${rule()}
${buildFiguresHtml(p, missing)}
${buildProjectsHtml(p)}
${takeHtml}

<!-- 9 button -->
<tr><td class="px" style="padding:24px ${PAD_X}px 0 ${PAD_X}px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
    <tr><td width="100%" align="center" style="width:100%;background:${ACCENT};border-radius:7px;text-align:center;">
      <a href="${launchUrl}" style="display:block;width:100%;padding:11px 0;font-size:13px;color:${ACCENT_TEXT};text-decoration:none;text-align:center;font-weight:500;font-family:${SANS};">Open Ari</a>
    </td></tr>
  </table>
</td></tr>

<!-- 10 footer -->
<tr><td class="px" style="padding:16px ${PAD_X}px 22px ${PAD_X}px;">
  <div style="font-size:11px;color:${META};">Sent by Ari &middot; <a href="https://useporta.com" style="color:${META};text-decoration:none;">useporta.com</a></div>
</td></tr>

</table>
</td></tr>
</table>
</div>
</body>
</html>`;

  return { subject, html };
}
