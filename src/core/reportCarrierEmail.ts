/**
 * Phase 2b (2026-08-17) — the email stops being the report and becomes the carrier for it.
 *
 * WHY. Mail clients strip the markup the charts need, so sent as email the report arrives broken
 * for a large share of recipients. The report is now a page at a permanent link; this message
 * exists only to get someone there.
 *
 * So it says exactly three things — project, period, and a button — and nothing else. No figures,
 * no task list, no summary: a client who reads a total in the email and a different total on the
 * page has been given two documents, and one of them is stale the moment anything changes.
 *
 * The reply line stays, verbatim in spirit. It was the best thing in the old email: the whole
 * design rests on a client being able to hit reply and reach a person.
 */

export interface CarrierEmail {
  projectName: string;
  rangeStartLocal: string;
  rangeEndLocal: string;
  reportUrl: string;
  fromName: string;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildCarrierEmail(input: CarrierEmail): { subject: string; html: string } {
  const period = `${input.rangeStartLocal} to ${input.rangeEndLocal}`;
  const subject = `${input.projectName} — progress report, ${period}`;

  // Table-based and inline-styled on purpose: this is the one artifact that still has to survive a
  // mail client, which is exactly why the report itself no longer travels this way.
  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f9f9f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f7;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:520px;background:#fcfcfb;border:1px solid rgba(11,11,11,0.10);border-radius:8px;">
        <tr><td style="padding:32px 32px 8px 32px;
                       font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
                       font-size:10px;font-weight:700;letter-spacing:.10em;
                       text-transform:uppercase;color:#898781;">
          Progress report
        </td></tr>
        <tr><td style="padding:0 32px;
                       font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
                       font-size:24px;font-weight:700;color:#0b0b0b;">
          ${esc(input.projectName)}
        </td></tr>
        <tr><td style="padding:8px 32px 0 32px;
                       font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
                       font-size:14px;color:#52514e;">
          ${esc(period)}
        </td></tr>
        <tr><td style="padding:28px 32px 32px 32px;">
          <a href="${esc(input.reportUrl)}"
             style="display:inline-block;background:#2a78d6;color:#ffffff;text-decoration:none;
                    font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
                    font-size:15px;font-weight:600;padding:13px 22px;border-radius:6px;">
            View the report
          </a>
        </td></tr>
        <tr><td style="padding:0 32px 30px 32px;
                       font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
                       font-size:13px;line-height:1.7;color:#898781;border-top:1px solid #e1e0d9;
                       padding-top:20px;">
          Questions about anything here? Reply to this email and it reaches
          ${esc(input.fromName)} directly.
        </td></tr>
      </table>
      <div style="max-width:520px;padding-top:16px;
                  font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
                  font-size:11px;color:#a2aab4;">
        Prepared with Ari
      </div>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html };
}
