/**
 * Step 10 (2026-08-14) — the client report, rendered as an email.
 *
 * THE ONE RENDERER. The confirm screen's "preview what they receive" and the actual send both call
 * `buildReportEmail`, so a preview that differed from what was sent would be worse than no preview
 * at all — it would be a promise the product broke silently. The agent never re-renders this
 * locally; it fetches from here.
 *
 * Design values are the cards': card #14171C, panels #1A1E26, hairlines #2A3038, text #F2F4F7 /
 * #8B929E / #6F7885, accent #3FBF7F on finished work only, decimal hours, tabular right-aligned
 * numbers, two weights, no gradients or shadows. Inline styles throughout because mail clients
 * discard <style> blocks.
 *
 * NOTHING ABOUT ANY PARTICULAR USER IS HARDCODED. The name and reply-to come from that user's own
 * account profile at send time; this file only lays them out.
 */

export interface ReportEmailLine {
  lineId: string;
  clientLabel: string;
  finished: boolean;
  hours: number;
}

export interface ReportEmailDay {
  dateLocal: string;
  hours: number;
}

export interface ReportEmailPayload {
  projectName: string;
  rangeStartLocal: string;
  rangeEndLocal: string;
  senderName: string;
  totalHours: number;
  daysWorked: number;
  tasksCompleted: number;
  tasksTotal: number;
  lines: ReportEmailLine[];
  daily: ReportEmailDay[];
}

const CARD = '#14171C';
const PANEL = '#1A1E26';
const HAIRLINE = '#2A3038';
const TEXT = '#F2F4F7';
const SECOND = '#8B929E';
const MUTED = '#6F7885';
const ACCENT = '#3FBF7F';
const TRACK = '#232931';
const UNFINISHED = '#5A626D';

/** Mail clients are hostile to anything clever; escaping is the whole defence. */
function esc(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hours(value: number): string {
  return `${(Math.round((value ?? 0) * 10) / 10).toFixed(1)}h`;
}

/** `2026-08-12` -> `12 Aug 2026`. Never `8/12/2026`: it means two different days by geography. */
function friendlyDate(iso: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  if (!parts) {
    return iso ?? '';
  }
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthIndex = Number(parts[2]) - 1;
  return `${Number(parts[3])} ${months[monthIndex] ?? '?'} ${parts[1]}`;
}

function dayLabel(iso: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  if (!parts) {
    return '';
  }
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(parts[3])} ${months[Number(parts[2]) - 1] ?? ''}`;
}

export function buildReportEmail(payload: ReportEmailPayload): { subject: string; html: string } {
  const lines = payload.lines ?? [];
  const daily = payload.daily ?? [];

  // The bar is proportional to the LARGEST line, so the shape is readable even when every line is
  // small. Sums are never re-derived here — the figures arrive already agreed with the page.
  const maxLine = lines.reduce((m, l) => Math.max(m, l.hours ?? 0), 0);
  const maxDay = daily.reduce((m, d) => Math.max(m, d.hours ?? 0), 0);

  const subject =
    `Work report — ${payload.projectName} — ` +
    `${friendlyDate(payload.rangeStartLocal)} to ${friendlyDate(payload.rangeEndLocal)}`;

  const figure = (value: string, label: string): string => `
    <td style="padding:0 18px 0 0;vertical-align:top;">
      <div style="font-size:26px;font-weight:500;color:${TEXT};font-variant-numeric:tabular-nums;">${esc(value)}</div>
      <div style="font-size:10px;font-weight:500;color:${MUTED};padding-top:4px;">${esc(label)}</div>
    </td>`;

  // Days not worked appear as gaps, never skipped (§4). A chart that hides empty days is the kind
  // of thing a client notices, and it costs trust permanently.
  const dayCells = daily
    .map((d) => {
      const h = d.hours ?? 0;
      const height = maxDay > 0 ? Math.max(h > 0 ? 3 : 1, Math.round((h / maxDay) * 64)) : 1;
      return `
        <td style="vertical-align:bottom;padding:0 3px;text-align:center;">
          <div style="height:${height}px;background:${h > 0 ? UNFINISHED : TRACK};border-radius:2px;"></div>
          <div style="font-size:9px;color:${MUTED};padding-top:6px;white-space:nowrap;">${esc(dayLabel(d.dateLocal))}</div>
        </td>`;
    })
    .join('');

  const lineRows = lines
    .map((l) => {
      const width = maxLine > 0 ? Math.max(4, Math.round(((l.hours ?? 0) / maxLine) * 120)) : 4;
      // Green means work that counted — a finished check and a finished bar. Nothing else.
      const barColour = l.finished ? ACCENT : UNFINISHED;
      const status = l.finished
        ? `<span style="color:${ACCENT};font-size:13px;">&#10003;</span>`
        : `<span style="color:${MUTED};font-size:11px;">in progress</span>`;

      return `
        <tr>
          <td style="padding:10px 12px;border-top:1px solid ${HAIRLINE};font-size:13px;color:${TEXT};">
            ${esc(l.clientLabel)}
          </td>
          <td style="padding:10px 12px;border-top:1px solid ${HAIRLINE};width:130px;">
            <div style="width:${width}px;height:6px;background:${barColour};border-radius:3px;"></div>
          </td>
          <td style="padding:10px 12px;border-top:1px solid ${HAIRLINE};text-align:right;white-space:nowrap;">
            ${status}
            <span style="font-size:13px;color:${TEXT};font-variant-numeric:tabular-nums;padding-left:8px;">${esc(hours(l.hours ?? 0))}</span>
          </td>
        </tr>`;
    })
    .join('');

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#0F1115;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0F1115;padding:28px 12px;">
<tr><td align="center">
  <table role="presentation" width="640" cellpadding="0" cellspacing="0"
         style="width:640px;max-width:100%;background:${CARD};border:1px solid ${HAIRLINE};border-radius:12px;
                font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <tr><td style="padding:26px 26px 0 26px;">
      <div style="font-size:10px;font-weight:500;color:${MUTED};letter-spacing:0.08em;">WORK REPORT</div>
      <div style="font-size:26px;font-weight:500;color:${TEXT};padding-top:6px;">${esc(payload.projectName)}</div>
      <div style="font-size:12px;color:${SECOND};padding-top:6px;">
        ${esc(friendlyDate(payload.rangeStartLocal))} &ndash; ${esc(friendlyDate(payload.rangeEndLocal))}
        &nbsp;&middot;&nbsp; ${esc(payload.senderName)}
      </div>
    </td></tr>

    <tr><td style="padding:20px 26px 0 26px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
             style="background:${PANEL};border:1px solid ${HAIRLINE};border-radius:8px;">
        <tr><td style="padding:16px 18px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            ${figure(hours(payload.totalHours), 'HOURS')}
            ${figure(String(payload.daysWorked ?? 0), 'DAYS WORKED')}
            ${figure(`${payload.tasksCompleted ?? 0} of ${payload.tasksTotal ?? 0}`, 'COMPLETED')}
          </tr></table>
        </td></tr>
      </table>
    </td></tr>

    ${
      daily.length > 0
        ? `<tr><td style="padding:14px 26px 0 26px;">
             <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
                    style="background:${PANEL};border:1px solid ${HAIRLINE};border-radius:8px;">
               <tr><td style="padding:16px 18px;">
                 <div style="font-size:10px;font-weight:500;color:${MUTED};padding-bottom:12px;">HOURS BY DAY</div>
                 <table role="presentation" cellpadding="0" cellspacing="0" style="height:88px;"><tr>${dayCells}</tr></table>
               </td></tr>
             </table>
           </td></tr>`
        : ''
    }

    <tr><td style="padding:14px 26px 0 26px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
             style="background:${PANEL};border:1px solid ${HAIRLINE};border-radius:8px;">
        <tr><td style="padding:16px 18px 4px 18px;">
          <div style="font-size:10px;font-weight:500;color:${MUTED};">THE WORK</div>
        </td></tr>
        <tr><td style="padding:0 6px 10px 6px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${lineRows}</table>
        </td></tr>
      </table>
    </td></tr>

    <tr><td style="padding:18px 26px 0 26px;">
      <div style="font-size:11px;color:${MUTED};line-height:1.6;">
        Time is recorded automatically while the work was actively in progress.
        Breaks and time away are not included.
      </div>
    </td></tr>

    <tr><td style="padding:18px 26px 26px 26px;">
      <div style="border-top:1px solid ${HAIRLINE};padding-top:14px;font-size:11px;color:${MUTED};">
        Measured by Ari &middot; <a href="https://useporta.com" style="color:${MUTED};text-decoration:underline;">useporta.com</a>
      </div>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

  return { subject, html };
}
