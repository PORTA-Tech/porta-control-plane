/**
 * Phase 2a (2026-08-17) — the client report as a web page.
 *
 * Built to `Ari_Report_V2_Mockup.html`, which is the agreed design and the source of every value
 * here. This is a PORT, not a redesign: where this file and the mockup differ, the mockup is right.
 *
 * Locked rules, not to be re-decided:
 *   - one fixed colour per task, identical in every chart, list and table
 *   - no pie chart; share of effort is a horizontal stacked bar
 *   - every chart is backed by the table, so nothing depends on colour alone
 *   - light background — the dark card styling is the app's, not a document's
 *   - hours appear, but below the work, never as the headline
 *   - no focus score, no pressure, no app breakdown, no distraction data. Ever.
 *
 * There is deliberately NO hosting, NO link and NO sending here. This function turns a data object
 * into a string of HTML; who stores it and who serves it is 2b.
 */

/** The four-way status the report groups by. */
export type ReportTaskStatus = 'planned' | 'in_progress' | 'done' | 'blocked';

export interface ReportTask {
  /** The CLIENT-FACING label. The raw task title never reaches this file. */
  label: string;
  status: ReportTaskStatus;
  hours: number;
  /** 1-8 = its own colour, permanent. 0 = no slot, folds into Other in the charts only. */
  colourSlot: number;
  /** The user's own one-line result. Empty is a first-class state — see the note on groups. */
  result: string;
  /** Free text as the report should read it: "14 – 17 Aug", "from 17 Aug", "held from 15 Aug". */
  dates: string;
  /** Shown as a flag under a blocked task. Empty renders nothing. */
  blockedReason?: string;
}

/** One day column. `segments` are the per-task splits that phase 0.1 records. */
export interface ReportDay {
  /** Short label under the column, e.g. "12 Aug". */
  label: string;
  segments: Array<{ taskLabel: string; colourSlot: number; hours: number }>;
}

export interface ReportPage {
  projectName: string;
  /** e.g. "12 – 17 August 2026". */
  period: string;
  /** Optional, e.g. "week 3". Omitted when empty. */
  periodNote?: string;
  preparedBy: string;
  sentOn: string;
  /** Rendered from a fixture in 2a. Wiring the live draft is 2b. Empty omits the section. */
  summary: string;
  tasks: ReportTask[];
  days: ReportDay[];
  /** Empty omits the whole Next section — never an empty heading. */
  nextSteps: string[];
}

/**
 * THE PALETTE. Eight slots, in this fixed order, never recycled and never repeated. The order was
 * run through a colourblind separation check and passes on every gate for ADJACENT marks, which is
 * what stacked bars and stacked columns are — so it must not be re-ordered and the hexes must not
 * be substituted. The order is the safety mechanism, not a preference.
 *
 * `ink` is the text colour that sits on the fill. Three of the eight are light enough that white
 * text on them falls below 3:1, so each slot carries its own answer rather than a global guess.
 */
const PALETTE: Array<{ fill: string; ink: string }> = [
  { fill: '#2a78d6', ink: '#ffffff' }, // 1 blue
  { fill: '#eb6834', ink: '#ffffff' }, // 2 orange
  { fill: '#1baf7a', ink: '#0b0b0b' }, // 3 aqua
  { fill: '#eda100', ink: '#0b0b0b' }, // 4 yellow
  { fill: '#e87ba4', ink: '#0b0b0b' }, // 5 magenta
  { fill: '#008300', ink: '#ffffff' }, // 6 green
  { fill: '#4a3aa7', ink: '#ffffff' }, // 7 violet
  { fill: '#e34948', ink: '#ffffff' }  // 8 red
];

/** Slot 0. Neutral by design: "Other" is an absence of a slot, not a ninth colour. */
const OTHER = { fill: '#c3c2b7', ink: '#0b0b0b' };
const OTHER_LABEL = 'Other';

function slotColour(slot: number): { fill: string; ink: string } {
  return PALETTE[slot - 1] ?? OTHER;
}

/** Client data reaches this page. Everything user-authored goes through here. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function h1(value: number): string {
  return value.toFixed(1);
}

/** Hours shown as decimals — the language of timesheets and invoices, which is what a client checks. */
function hoursLabel(value: number): string {
  return `${h1(value)}h`;
}

const STATUS_ORDER: ReportTaskStatus[] = ['done', 'in_progress', 'blocked', 'planned'];

const STATUS_TITLE: Record<ReportTaskStatus, string> = {
  done: 'Completed',
  in_progress: 'In progress',
  blocked: 'Blocked',
  planned: 'Planned'
};

const STATUS_COLOUR: Record<ReportTaskStatus, string> = {
  done: 'var(--success-text)',
  in_progress: 'var(--ink-2)',
  blocked: 'var(--critical)',
  planned: 'var(--muted)'
};

/**
 * The charts fold slot 0 into one Other slice; the TABLE never does. That split is the whole
 * agreement: the chart stays readable and the document stays complete.
 */
function foldForCharts(
  entries: Array<{ label: string; colourSlot: number; hours: number }>
): Array<{ label: string; colourSlot: number; hours: number }> {
  const own = entries.filter((e) => e.colourSlot >= 1 && e.colourSlot <= PALETTE.length);
  const other = entries.filter((e) => e.colourSlot < 1 || e.colourSlot > PALETTE.length);

  if (other.length === 0) {
    return own;
  }

  const folded = other.reduce((sum, e) => sum + e.hours, 0);
  return [...own, { label: `${OTHER_LABEL} (${other.length} tasks)`, colourSlot: 0, hours: folded }];
}

function renderKpis(page: ReportPage, totalHours: number, daysWorked: number): string {
  const done = page.tasks.filter((t) => t.status === 'done');
  const inProgress = page.tasks.filter((t) => t.status === 'in_progress');
  const blocked = page.tasks.filter((t) => t.status === 'blocked');

  // A zero is good news and is shown in the ordinary ink, never in the alarm colour. Only a real
  // blocked count earns red.
  const blockedStyle = blocked.length > 0 ? ' style="color:var(--critical);"' : '';

  const detail = (list: ReportTask[], empty: string): string =>
    list.length === 0 ? empty : esc(list.map((t) => t.label).join(', '));

  return `
    <div class="kpis">
      <div class="kpi">
        <div class="v">${hoursLabel(totalHours)}</div>
        <div class="l">Hours worked</div>
        <div class="d">across ${daysWorked} ${daysWorked === 1 ? 'day' : 'days'}</div>
      </div>
      <div class="kpi">
        <div class="v">${done.length}</div>
        <div class="l">Completed</div>
        <div class="d">of ${page.tasks.length} ${page.tasks.length === 1 ? 'task' : 'tasks'}</div>
      </div>
      <div class="kpi">
        <div class="v">${inProgress.length}</div>
        <div class="l">In progress</div>
        <div class="d">${detail(inProgress, '&mdash;')}</div>
      </div>
      <div class="kpi">
        <div class="v"${blockedStyle}>${blocked.length}</div>
        <div class="l">Blocked</div>
        <div class="d">${detail(blocked, 'nothing held up')}</div>
      </div>
    </div>`;
}

function renderShare(page: ReportPage, totalHours: number): string {
  if (totalHours <= 0) {
    return '';
  }

  const folded = foldForCharts(
    page.tasks.map((t) => ({ label: t.label, colourSlot: t.colourSlot, hours: t.hours }))
  ).filter((e) => e.hours > 0);

  if (folded.length === 0) {
    return '';
  }

  const segments = folded
    .map((e) => {
      const pct = (e.hours / totalHours) * 100;
      const c = slotColour(e.colourSlot);
      // A sliver cannot hold a legible number. Below this the legend and the table carry it,
      // which is exactly why the table exists.
      const label = pct >= 7 ? `${Math.round(pct)}%` : '';
      const tip = `${e.label} · ${hoursLabel(e.hours)} · ${Math.round(pct)}%`;
      return `<span data-tip="${esc(tip)}" style="width:${pct.toFixed(1)}%;background:${c.fill};color:${c.ink};">${label}</span>`;
    })
    .join('\n      ');

  const legend = folded
    .map((e) => {
      const c = slotColour(e.colourSlot);
      return `<div class="lg"><i class="chip" style="background:${c.fill}"></i>${esc(e.label)}</div>`;
    })
    .join('\n      ');

  return `
  <div class="pad" style="padding-top:26px;">
    <div class="sec-title">Where the time went</div>
    <div class="sec-sub" style="padding-bottom:14px;">Share of the ${hoursLabel(totalHours)}, by task.</div>
    <div class="share">
      ${segments}
    </div>
    <div class="legend">
      ${legend}
    </div>
  </div>`;
}

const MAX_COLUMN_PX = 150;

/**
 * Below this many worked days the day chart is replaced by a sentence. Yadin's decision,
 * 2026-08-17, and one line to revert.
 *
 * <b>This is not hiding empty days.</b> Every worked day is still named, with its hours, in prose.
 * What it stops is drawing a DISTRIBUTION when there is no distribution to draw: one tall column
 * beside six flat lines reads as a chart that failed rather than as a short week, which is exactly
 * how the thin-week fixture looked when phase 2a rendered it.
 */
const MIN_DAYS_FOR_CHART = 3;

/** "17 August" · "14 and 17 August" · "12, 14 and 17 August" — a list a person would say aloud. */
function joinDays(labels: string[]): string {
  if (labels.length <= 1) {
    return labels[0] ?? '';
  }
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

function renderDays(page: ReportPage): string {
  if (page.days.length === 0) {
    return '';
  }

  const dayTotals = page.days.map((d) => d.segments.reduce((s, seg) => s + seg.hours, 0));
  const peak = Math.max(...dayTotals, 0);

  const worked = page.days
    .map((d, i) => ({ label: d.label, hours: dayTotals[i] ?? 0 }))
    .filter((d) => d.hours > 0);

  if (worked.length > 0 && worked.length < MIN_DAYS_FOR_CHART) {
    const total = worked.reduce((s, d) => s + d.hours, 0);
    const sentence =
      worked.length === 1
        ? `${hoursLabel(total)}, worked on ${worked[0]!.label}.`
        : `${hoursLabel(total)} across ${worked.length} days — ${joinDays(
            worked.map((d) => `${d.label} (${hoursLabel(d.hours)})`)
          )}.`;

    return `
  <div class="pad" style="padding-top:32px;">
    <div class="sec-title">Effort by day</div>
    <div class="sec-sub" style="padding-bottom:2px;">${esc(sentence)}</div>
  </div>`;
  }

  const columns = page.days
    .map((day, i) => {
      const total = dayTotals[i] ?? 0;

      if (total <= 0 || peak <= 0) {
        // A day with nothing on it is a GAP, not a removed column. A chart that hides empty days
        // is the kind of thing a client notices, and it costs trust permanently.
        return `
      <div class="colwrap">
        <div class="coltot" style="color:var(--muted);">&mdash;</div>
        <div class="stack" style="height:2px;"><div class="zero" data-tip="${esc(day.label)} · no work on this project"></div></div>
        <div class="collab">${esc(day.label)}</div>
      </div>`;
      }

      const folded = foldForCharts(
        day.segments.map((s) => ({ label: s.taskLabel, colourSlot: s.colourSlot, hours: s.hours }))
      ).filter((s) => s.hours > 0);

      const columnPx = Math.max(4, Math.round((total / peak) * MAX_COLUMN_PX));
      const segs = folded
        .map((s) => {
          const c = slotColour(s.colourSlot);
          const px = Math.max(2, Math.round((s.hours / total) * columnPx));
          const tip = `${day.label} · ${s.label} · ${hoursLabel(s.hours)}`;
          return `<div class="seg" data-tip="${esc(tip)}" style="height:${px}px;background:${c.fill};"></div>`;
        })
        .join('\n          ');

      return `
      <div class="colwrap">
        <div class="coltot">${hoursLabel(total)}</div>
        <div class="stack" style="height:${columnPx}px;">
          ${segs}
        </div>
        <div class="collab">${esc(day.label)}</div>
      </div>`;
    })
    .join('');

  return `
  <div class="pad" style="padding-top:32px;">
    <div class="sec-title">Effort by day</div>
    <div class="sec-sub" style="padding-bottom:6px;">Each day split by the task worked on. Days with
      no work on this project are shown as gaps rather than removed.</div>
    <div class="cols">${columns}
    </div>
  </div>`;
}

function groupSubtitle(status: ReportTaskStatus, list: ReportTask[]): string {
  const hours = list.reduce((s, t) => s + t.hours, 0);
  const count = `${list.length} ${list.length === 1 ? 'task' : 'tasks'}`;
  if (status === 'in_progress') {
    return `${count} &middot; ${hoursLabel(hours)} so far`;
  }
  return `${count} &middot; ${hoursLabel(hours)}`;
}

function renderWork(page: ReportPage): string {
  if (page.tasks.length === 0) {
    return '';
  }

  const groups = STATUS_ORDER.map((status) => {
    const list = page.tasks.filter((t) => t.status === status);
    if (list.length === 0) {
      // An empty group is omitted entirely, heading included. Never explain a thing that is not
      // on the page.
      return '';
    }

    const rows = list
      .map((task) => {
        const c = slotColour(task.colourSlot);

        // A SKIPPED RESULT LINE IS A FIRST-CLASS STATE. The user is never required to write one,
        // so the row omits the sentence rather than printing a placeholder or an apology. What is
        // left — the name, the hours and the dates — is still true and still reads deliberately.
        const result =
          task.result.trim().length > 0
            ? `\n        <div class="res">${esc(task.result.trim())}</div>`
            : '';

        const flag =
          task.status === 'blocked' && (task.blockedReason ?? '').trim().length > 0
            ? `\n        <div style="padding-top:9px;">
          <span class="flag" style="color:var(--critical);border-color:var(--critical);">&#9888; ${esc(task.blockedReason!.trim())}</span>
        </div>`
            : '';

        return `
    <div class="task">
      <div class="bar" style="background:${c.fill};"></div>
      <div class="body">
        <div class="name">${esc(task.label)}</div>${result}${flag}
      </div>
      <div class="meta"><div class="hrs">${hoursLabel(task.hours)}</div><div class="dates">${esc(task.dates)}</div></div>
    </div>`;
      })
      .join('');

    return `
    <div class="grp-head" style="padding-top:26px;">
      <span class="grp-name" style="color:${STATUS_COLOUR[status]};">${STATUS_TITLE[status]}</span>
      <span class="grp-count">${groupSubtitle(status, list)}</span>
    </div>${rows}`;
  })
    .filter((s) => s.length > 0)
    .join('');

  return `
  <div class="pad" style="padding-top:26px;">
    <div class="sec-title" style="padding-bottom:4px;">The work</div>${groups}
  </div>`;
}

function renderNext(page: ReportPage): string {
  if (page.nextSteps.length === 0) {
    return '';
  }

  const items = page.nextSteps
    .map((step, i) => `<li><span class="n">${i + 1}</span><span>${esc(step)}</span></li>`)
    .join('\n      ');

  return `
  <div style="height:30px;"></div>
  <div class="rule"></div>
  <div class="pad next" style="padding-top:26px;">
    <div class="sec-title" style="padding-bottom:10px;">Next</div>
    <ul>
      ${items}
    </ul>
  </div>`;
}

/**
 * THE TABLE. Every task, individually, by name — including the ones the charts folded into Other.
 * This is what makes the colour fold acceptable and what makes the whole document readable to
 * someone who cannot separate two of the hues.
 */
function renderTable(page: ReportPage, totalHours: number, daysWorked: number): string {
  if (page.tasks.length === 0) {
    return '';
  }

  const rows = page.tasks
    .map((task) => {
      const c = slotColour(task.colourSlot);
      const pct = totalHours > 0 ? Math.round((task.hours / totalHours) * 100) : 0;
      // Slot 0 rows carry the neutral chip, so the reader can see WHICH rows the chart folded.
      return `
        <tr>
          <td class="nm"><i class="chip" style="background:${c.fill};display:inline-block;margin-right:8px;"></i>${esc(task.label)}</td>
          <td>${STATUS_TITLE[task.status]}</td><td>${esc(task.dates)}</td><td class="num">${h1(task.hours)}</td><td class="num">${pct}%</td>
        </tr>`;
    })
    .join('');

  return `
  <div class="pad" style="padding-top:30px;">
    <div class="sec-title" style="padding-bottom:12px;">All tasks</div>
    <table class="tv">
      <thead>
        <tr>
          <th style="width:34%;">Task</th>
          <th>Status</th>
          <th>Dates</th>
          <th class="num" style="text-align:right;">Hours</th>
          <th class="num" style="text-align:right;">Share</th>
        </tr>
      </thead>
      <tbody>${rows}
        <tr>
          <td class="nm" style="font-weight:650;">Total</td>
          <td></td><td>${daysWorked} ${daysWorked === 1 ? 'day' : 'days'} worked</td>
          <td class="num" style="font-weight:650;">${h1(totalHours)}</td><td class="num">${totalHours > 0 ? '100%' : '0%'}</td>
        </tr>
      </tbody>
    </table>
  </div>`;
}

export function buildReportPage(page: ReportPage): string {
  const totalHours = page.tasks.reduce((s, t) => s + t.hours, 0);
  const daysWorked = page.days.filter((d) => d.segments.reduce((s, x) => s + x.hours, 0) > 0).length;
  const doneCount = page.tasks.filter((t) => t.status === 'done').length;
  const progressPct = page.tasks.length > 0 ? (doneCount / page.tasks.length) * 100 : 0;

  const summary =
    page.summary.trim().length > 0
      ? `
  <div class="pad" style="padding-top:26px;">
    <div class="eyebrow" style="padding-bottom:10px;">Summary</div>
    <p class="summary" style="margin:0;">${esc(page.summary.trim())}</p>
  </div>`
      : '';

  const periodNote = (page.periodNote ?? '').trim().length > 0
    ? ` &nbsp;&middot;&nbsp; ${esc(page.periodNote!.trim())}`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Phase 2b. In the FROZEN page as well as on the response header, because the header is a
     property of how this copy was served and the meta travels with the file wherever it goes —
     saved, forwarded, or opened from disk. A client's project details must not be indexable. -->
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">
<meta name="referrer" content="no-referrer">
<title>${esc(page.projectName)} — progress report, ${esc(page.period)}</title>
<style>
  .viz-root{
    color-scheme: light;
    --plane:#f9f9f7;
    --surface:#fcfcfb;
    --ink:#0b0b0b;
    --ink-2:#52514e;
    --muted:#898781;
    --grid:#e1e0d9;
    --baseline:#c3c2b7;
    --ring:rgba(11,11,11,0.10);
    --critical:#d03b3b;
    --success-text:#006300;
  }
  *{box-sizing:border-box;}
  body{
    margin:0;
    background:var(--plane);
    font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
    color:var(--ink);
    -webkit-font-smoothing:antialiased;
  }
  .sheet{max-width:820px;margin:32px auto;background:var(--surface);
    border:1px solid var(--ring);border-radius:8px;overflow:hidden;}
  .pad{padding:0 40px;}
  .rule{height:1px;background:var(--grid);margin:0 40px;}
  .eyebrow{font-size:10px;font-weight:650;letter-spacing:.10em;color:var(--muted);text-transform:uppercase;}
  .sec-title{font-size:13px;font-weight:650;color:var(--ink);letter-spacing:.01em;}
  .sec-sub{font-size:12px;color:var(--muted);padding-top:3px;line-height:1.5;}

  header{padding:36px 40px 0 40px;display:flex;justify-content:space-between;gap:24px;align-items:flex-start;}
  h1{font-size:30px;font-weight:650;margin:8px 0 0 0;letter-spacing:-.01em;}
  .period{font-size:13px;color:var(--ink-2);padding-top:8px;}
  .by{text-align:right;font-size:12px;color:var(--muted);white-space:nowrap;line-height:1.7;}
  .by strong{display:block;font-size:14px;color:var(--ink);font-weight:650;}

  .summary{font-size:15px;line-height:1.7;color:#232b35;max-width:64ch;}

  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--grid);
        border:1px solid var(--grid);border-radius:6px;overflow:hidden;}
  .kpi{background:var(--surface);padding:16px 18px;}
  .kpi .v{font-size:26px;font-weight:650;line-height:1.1;}
  .kpi .l{font-size:10px;font-weight:650;letter-spacing:.07em;color:var(--muted);text-transform:uppercase;padding-top:6px;}
  .kpi .d{font-size:11px;color:var(--ink-2);padding-top:5px;overflow:hidden;text-overflow:ellipsis;}

  .meter-track{height:8px;background:var(--grid);border-radius:4px;overflow:hidden;display:flex;}
  .meter-fill{background:#2a78d6;height:100%;border-radius:4px;}

  .share{display:flex;gap:2px;height:34px;}
  .share span{display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:650;
    border-radius:3px;cursor:default;overflow:hidden;}
  .share span:first-child{border-radius:4px 3px 3px 4px;}
  .share span:last-child{border-radius:3px 4px 4px 3px;}

  .cols{display:flex;align-items:flex-end;gap:14px;height:172px;padding-top:6px;}
  .stack{display:flex;flex-direction:column-reverse;gap:2px;width:100%;max-width:64px;justify-content:flex-end;}
  .seg{border-radius:2px;cursor:default;}
  .seg:last-child{border-radius:4px 4px 2px 2px;}
  .zero{height:2px;background:var(--baseline);width:100%;max-width:64px;border-radius:1px;}
  .coltot{font-size:11px;color:var(--ink);font-variant-numeric:tabular-nums;padding-bottom:6px;height:16px;}
  .collab{font-size:11px;color:var(--muted);padding-top:8px;white-space:nowrap;}
  .colwrap{display:flex;flex-direction:column;align-items:center;flex:1;}

  .legend{display:flex;flex-wrap:wrap;gap:16px;padding-top:16px;}
  .lg{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--ink-2);}
  .chip{width:10px;height:10px;border-radius:2px;flex:none;}

  .grp-head{display:flex;align-items:center;gap:8px;padding-bottom:2px;}
  .grp-name{font-size:11px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;}
  .grp-count{font-size:11px;color:var(--muted);}
  .task{display:flex;gap:16px;padding:16px 0;border-top:1px solid var(--grid);}
  .task .bar{width:3px;border-radius:2px;flex:none;}
  .task .body{flex:1;min-width:0;}
  .task .name{font-size:15px;font-weight:600;line-height:1.35;}
  .task .res{font-size:13.5px;color:var(--ink-2);line-height:1.65;padding-top:5px;max-width:62ch;}
  .task .meta{text-align:right;white-space:nowrap;flex:none;}
  .task .hrs{font-size:14px;font-variant-numeric:tabular-nums;font-weight:600;}
  .task .dates{font-size:11px;color:var(--muted);padding-top:5px;}
  .flag{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:650;
        padding:3px 8px;border-radius:999px;border:1px solid var(--ring);}

  .next li{font-size:14px;color:#232b35;line-height:1.7;padding:7px 0;border-top:1px solid var(--grid);
           list-style:none;display:flex;gap:10px;}
  .next ul{margin:0;padding:0;}
  .next .n{color:var(--muted);font-variant-numeric:tabular-nums;flex:none;}

  table.tv{width:100%;border-collapse:collapse;font-size:12.5px;}
  table.tv th{text-align:left;font-size:10px;letter-spacing:.07em;text-transform:uppercase;
    color:var(--muted);font-weight:650;padding:0 10px 8px 0;border-bottom:1px solid var(--grid);}
  table.tv td{padding:9px 10px 9px 0;border-bottom:1px solid var(--grid);color:var(--ink-2);}
  table.tv td.num{text-align:right;font-variant-numeric:tabular-nums;color:var(--ink);}
  table.tv td.nm{color:var(--ink);}

  footer{padding:24px 40px 34px 40px;font-size:12px;color:var(--muted);line-height:1.7;}

  #tip{position:fixed;pointer-events:none;opacity:0;transition:opacity .09s;
    background:#161615;color:#fff;font-size:12px;line-height:1.45;padding:7px 10px;border-radius:5px;
    white-space:nowrap;z-index:99;box-shadow:0 2px 10px rgba(0,0,0,.18);}
  @media print{ body{background:#fff;} .sheet{border:0;margin:0;} }
  @media (max-width:640px){
    .pad,header,footer{padding-left:20px;padding-right:20px;}
    .rule{margin:0 20px;}
    .kpis{grid-template-columns:repeat(2,1fr);}
    header{flex-direction:column;}
    .by{text-align:left;}
  }
</style>
</head>
<body class="viz-root">
<div id="tip"></div>
<div class="sheet">
  <header>
    <div>
      <div class="eyebrow">Progress report</div>
      <h1>${esc(page.projectName)}</h1>
      <div class="period">${esc(page.period)}${periodNote}</div>
    </div>
    <div class="by">
      Prepared by
      <strong>${esc(page.preparedBy)}</strong>
      ${esc(page.sentOn)}
    </div>
  </header>

  <div style="height:26px;"></div>
  <div class="rule"></div>
${summary}

  <div class="pad" style="padding-top:26px;">
    ${renderKpis(page, totalHours, daysWorked)}
  </div>

  <div class="pad" style="padding-top:24px;">
    <div style="display:flex;justify-content:space-between;align-items:baseline;padding-bottom:9px;">
      <div class="sec-title">Project progress</div>
      <div style="font-size:12px;color:var(--ink-2);">${doneCount} of ${page.tasks.length} tasks complete</div>
    </div>
    <div class="meter-track"><div class="meter-fill" style="width:${progressPct.toFixed(0)}%;"></div></div>
    <div class="sec-sub">Counted by task, not by hours. Tasks are not equal in size, so this is a
      count and not an estimate of remaining effort.</div>
  </div>

  <div style="height:30px;"></div>
  <div class="rule"></div>
${renderShare(page, totalHours)}
${renderDays(page)}

  <div style="height:32px;"></div>
  <div class="rule"></div>
${renderWork(page)}
${renderNext(page)}
${renderTable(page, totalHours, daysWorked)}

  <footer>
    Hours are recorded automatically while work was actively in progress. Breaks and time away
    are not included, and nothing is sent until ${esc(page.preparedBy)} has reviewed it.
    <br><br>
    Questions about anything here? Reply to this email and it reaches ${esc(page.preparedBy)} directly.
  </footer>
</div>

<div style="max-width:820px;margin:0 auto 40px auto;text-align:center;font-size:11px;color:#a2aab4;">
  Prepared with Ari
</div>

<script>
  const tip = document.getElementById('tip');
  document.querySelectorAll('[data-tip]').forEach(el=>{
    el.addEventListener('mouseenter',()=>{ tip.textContent = el.dataset.tip; tip.style.opacity = 1; });
    el.addEventListener('mousemove',e=>{
      const pad = 14;
      let x = e.clientX + pad, y = e.clientY + pad;
      const r = tip.getBoundingClientRect();
      if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
      if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    });
    el.addEventListener('mouseleave',()=>{ tip.style.opacity = 0; });
  });
</script>
</body>
</html>`;
}
