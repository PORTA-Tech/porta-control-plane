import { Router } from 'express';
import { allowDeviceAccountAccess, requireDeviceAuth, type DeviceRequest } from '../middleware/deviceAuth.js';
import { draftReportSummary, type SummaryTask } from '../../core/reportSummary.js';
import { buildReportPage, type ReportPage, type ReportTask, type ReportTaskStatus } from '../../core/reportPageBuilder.js';
import { buildCarrierEmail } from '../../core/reportCarrierEmail.js';
import { randomBytes } from 'node:crypto';
import { getAccountProfile } from '../../store/accountStore.js';
import { sendEmail } from '../../core/emailService.js';
import { buildReportEmail, type ReportEmailPayload } from '../../core/reportEmailBuilder.js';
import {
  claimReportForSend,
  deleteSentReport,
  markReportOutcome
} from '../../store/sentReportStore.js';

/**
 * Step 10 phase C/D (2026-08-14) — client reports: preview, send, delete.
 *
 * THE SERVER SENDS, and that is a reversal. Until Resend replaced Gmail the machine sent, and
 * "nothing server-side can cause an email to leave the user's address" was a structural guarantee.
 * It is gone (spec §12.4), and these are the three bounds that replace it:
 *
 *   1. THE SERVER NEVER ORIGINATES. Every route here requires a proven device credential and acts
 *      only on the report in that request. There is no scheduler, no queue, no retry loop, and no
 *      operator route that takes a reportId and sends it. If you are adding one, you are undoing
 *      the bound.
 *   2. reportId IS THE IDEMPOTENCY KEY. `claimReportForSend` is an INSERT that fails closed on a
 *      duplicate, so a retried request after a successful send cannot put a second copy in a
 *      client's inbox.
 *   3. RECORDED BEFORE ATTEMPTED, so a crash mid-send leaves a `pending` row rather than a silence.
 *
 * SENDER IDENTITY IS RESOLVED HERE, NEVER ACCEPTED FROM THE PAYLOAD. From name and reply-to come
 * from the account profile this server already holds and already uses to address the digest. A
 * client asserting its own sender identity is exactly what dropping `senderName`/`senderEmail` from
 * §12.2 was meant to prevent.
 */

const FROM_ADDRESS = 'reports@useporta.com';

/** Non-deliverable by design; a reply to one vanishes silently. Refused, never warned about. */
const SYNTHETIC_DOMAIN = '@porta.internal';

interface ReportRequestBody {
  reportId?: unknown;
  accountId?: unknown;
  deviceId?: unknown;
  machineId?: unknown;
  requestedAtUtc?: unknown;
  timezoneOffsetMinutes?: unknown;
  projectName?: unknown;
  rangeStartLocal?: unknown;
  rangeEndLocal?: unknown;
  recipientEmail?: unknown;
  recipientName?: unknown;
  totalHours?: unknown;
  daysWorked?: unknown;
  tasksCompleted?: unknown;
  tasksTotal?: unknown;
  lines?: unknown;
  daily?: unknown;
  // Phase 2b — approved 2026-08-17.
  summary?: unknown;
  nextSteps?: unknown;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isSynthetic(address: string): boolean {
  return address.toLowerCase().endsWith(SYNTHETIC_DOMAIN);
}

function looksLikeAddress(address: string): boolean {
  const at = address.indexOf('@');
  return (
    address.length > 0 &&
    at > 0 &&
    at === address.lastIndexOf('@') &&
    at < address.length - 1 &&
    address.indexOf('.', at) > at + 1 &&
    !address.endsWith('.') &&
    !/\s/.test(address)
  );
}

/**
 * The approved field list (§12.2), and nothing outside it. A field that arrives here without being
 * named in the spec is dropped rather than stored: the standing rule is that every live-data write
 * is named before it is made.
 */
function toEmailPayload(body: ReportRequestBody, senderName: string): ReportEmailPayload | null {
  const projectName = str(body.projectName);
  const rangeStartLocal = str(body.rangeStartLocal);
  const rangeEndLocal = str(body.rangeEndLocal);

  if (!projectName || !rangeStartLocal || !rangeEndLocal) {
    return null;
  }

  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  const rawDaily = Array.isArray(body.daily) ? body.daily : [];

  const lines = rawLines
    .map((l) => {
      const line = (l ?? {}) as Record<string, unknown>;
      return {
        lineId: str(line.lineId),
        clientLabel: str(line.clientLabel),
        finished: line.finished === true,
        hours: num(line.hours)
      };
    })
    // A line with no client-facing label must never render: the fallback would be the raw title,
    // which is a private note (§3). The agent blocks this too; this is the second lock.
    .filter((l) => l.clientLabel.length > 0);

  if (lines.length === 0) {
    return null;
  }

  return {
    projectName,
    rangeStartLocal,
    rangeEndLocal,
    senderName,
    totalHours: num(body.totalHours),
    daysWorked: Math.trunc(num(body.daysWorked)),
    tasksCompleted: Math.trunc(num(body.tasksCompleted)),
    tasksTotal: Math.trunc(num(body.tasksTotal)),
    lines,
    // Days with zero hours are KEPT: §4 requires days not worked to appear as gaps, and a gap the
    // payload does not carry cannot be drawn.
    daily: rawDaily.map((d) => {
      const day = (d ?? {}) as Record<string, unknown>;
      return { dateLocal: str(day.dateLocal), hours: num(day.hours) };
    })
  };
}

async function resolveSender(accountId: string): Promise<
  { ok: true; fromName: string; replyTo: string } | { ok: false; reason: string }
> {
  const profile = await getAccountProfile(accountId);
  if (!profile) {
    return { ok: false, reason: 'account_not_found' };
  }

  const fromName = (profile.displayName ?? '').trim();
  const replyTo = (profile.primaryEmail ?? '').trim();

  if (!fromName) {
    return { ok: false, reason: 'from_name_missing' };
  }

  // THE HARD BLOCK. displaced-<accountId>@porta.internal is assigned on an email collision, so a
  // profile can hold an address nobody reads. A client replying to it is a guaranteed silent
  // failure, and the entire design rests on reply reaching the user.
  if (isSynthetic(replyTo)) {
    return { ok: false, reason: 'reply_to_synthetic' };
  }

  if (!looksLikeAddress(replyTo)) {
    return { ok: false, reason: 'reply_to_invalid' };
  }

  return { ok: true, fromName, replyTo };
}

/**
 * Phase 2b — where the report page lives. Overridable so a staging deploy links to itself.
 */
const PUBLIC_BASE_URL = (process.env.PORTA_PUBLIC_BASE_URL ?? 'https://porta-control-plane.onrender.com').replace(/\/+$/, '');

/**
 * The link's whole security model.
 *
 * 32 bytes of CSPRNG, base64url — 256 bits. Not the report id, not sequential, not derived from
 * anything about the account: a client will not make an account, so the page has no login and this
 * token IS the access control. Enumerating a counter would have been trivial, which is exactly why
 * the report id is never used here.
 */
function newPageToken(): string {
  return randomBytes(32).toString('base64url');
}

function reportUrlFor(token: string): string {
  return `${PUBLIC_BASE_URL}/r/${token}`;
}

const STATUS_VALUES: ReportTaskStatus[] = ['planned', 'in_progress', 'done', 'blocked'];

function toStatus(value: unknown): ReportTaskStatus {
  const s = str(value);
  return (STATUS_VALUES as string[]).includes(s) ? (s as ReportTaskStatus) : 'planned';
}

/**
 * Turn the approved payload into the renderer's input.
 *
 * Field by field, like `toSummaryFacts` and for the same reason: what a client's document can show
 * is bounded by what is read HERE, not by what the agent happens to put on the wire. A field added
 * upstream cannot reach a client's page without being added to this function on purpose.
 */
function toReportPage(body: ReportRequestBody, fromName: string, sentOn: string): ReportPage | null {
  const projectName = str(body.projectName);
  const rangeStartLocal = str(body.rangeStartLocal);
  const rangeEndLocal = str(body.rangeEndLocal);

  if (!projectName || !rangeStartLocal || !rangeEndLocal) {
    return null;
  }

  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  const byLineId = new Map<string, { label: string; slot: number }>();

  const tasks: ReportTask[] = rawLines
    .map((entry) => {
      const l = (entry ?? {}) as Record<string, unknown>;
      const label = str(l.clientLabel);
      const slot = Math.trunc(num(l.colourSlot));
      byLineId.set(str(l.lineId), { label, slot });
      return {
        label,
        status: toStatus(l.status),
        hours: num(l.hours),
        colourSlot: slot,
        result: str(l.result),
        dates: str(l.dates),
        blockedReason: str(l.blockedReason)
      };
    })
    .filter((t) => t.label.length > 0);

  const rawDaily = Array.isArray(body.daily) ? body.daily : [];
  const days = rawDaily.map((entry) => {
    const d = (entry ?? {}) as Record<string, unknown>;
    const rawSegments = Array.isArray(d.segments) ? d.segments : [];
    return {
      label: str(d.dateLabel) || str(d.dateLocal),
      segments: rawSegments
        .map((sEntry) => {
          const s = (sEntry ?? {}) as Record<string, unknown>;
          const ref = byLineId.get(str(s.lineId));
          return {
            taskLabel: ref?.label ?? '',
            colourSlot: ref?.slot ?? 0,
            hours: num(s.hours)
          };
        })
        .filter((s) => s.hours > 0)
    };
  });

  return {
    projectName,
    period: `${rangeStartLocal} – ${rangeEndLocal}`,
    preparedBy: fromName,
    sentOn,
    summary: str(body.summary),
    tasks,
    days,
    nextSteps: (Array.isArray(body.nextSteps) ? body.nextSteps : [])
      .map((n) => str(n))
      .filter((n) => n.length > 0)
  };
}


export function createReportsController(): Router {
  const router = Router();

  /**
   * Phase 0.2 (2026-08-17) — who the report will come from.
   *
   * ReadIdentityAsync on the agent used to hardcode both of these empty, because §12.2 put sender
   * identity on the server so there would be one copy of it. But the local preflight refuses an
   * empty From name and an empty Reply-to, and the confirm screen prefills from the agent — so
   * both boxes arrived blank and every send was refused until the user typed their own name and
   * address. It worked for the founder, who knows what to type, and dead-ended everyone else.
   *
   * The fix keeps the single source and adds a way to READ it. This is data coming IN to the
   * machine, not out: the account's own display name and email, returned to that account's own
   * device. It is the same pair `resolveSender` uses at send time, so what the confirm screen
   * shows is what the client will actually see — not a second copy that can drift.
   */
  router.get('/sender', requireDeviceAuth, async (req: DeviceRequest, res, next) => {
    try {
      const accountId = str(req.query.accountId);
      if (!accountId) {
        res.status(400).json({ success: false, reason: 'account_id_required' });
        return;
      }

      if (!(await allowDeviceAccountAccess(req, accountId, 'reports/sender'))) {
        res.status(403).json({ success: false, reason: 'device_account_mismatch' });
        return;
      }

      const sender = await resolveSender(accountId);
      if (!sender.ok) {
        // The same reason codes the send path returns, so one vocabulary explains both.
        res.status(200).json({ success: false, reason: sender.reason });
        return;
      }

      res.status(200).json({
        success: true,
        fromName: sender.fromName,
        fromAddress: FROM_ADDRESS,
        replyTo: sender.replyTo
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Phase 1.4 (2026-08-17) — draft the summary paragraph.
   *
   * The request body is the ONLY thing the model sees, and it carries exactly the fields Yadin
   * approved on 2026-08-17: the client-facing project name, and per task the client-facing label,
   * status, hours and one-line result. Everything else on the wire is dropped here rather than
   * being trusted not to matter — see `toSummaryFacts`.
   *
   * Drafting is not sending. Nothing here writes a report, and the user edits the result.
   */
  router.post('/summary', requireDeviceAuth, async (req: DeviceRequest, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const accountId = str(body.accountId);
      if (!accountId) {
        res.status(400).json({ success: false, reason: 'account_id_required' });
        return;
      }

      if (!(await allowDeviceAccountAccess(req, accountId, 'reports/summary'))) {
        res.status(403).json({ success: false, reason: 'device_account_mismatch' });
        return;
      }

      const rawTasks = Array.isArray(body.tasks) ? body.tasks : [];
      // Rebuilt field by field. A field the agent adds later cannot ride along into the model
      // call by accident — it has to be added here, on purpose, which is the point.
      const tasks: SummaryTask[] = rawTasks.map((entry) => {
        const t = (entry ?? {}) as Record<string, unknown>;
        const status = str(t.status);
        return {
          clientLabel: str(t.clientLabel),
          status: (['planned', 'in_progress', 'done', 'blocked'].includes(status)
            ? status
            : 'planned') as SummaryTask['status'],
          hours: num(t.hours),
          result: str(t.result),
          blockedReason: str(t.blockedReason)
        };
      }).filter((t) => t.clientLabel.length > 0);

      if (tasks.length === 0) {
        res.status(200).json({ success: false, reason: 'nothing_to_summarise' });
        return;
      }

      const summary = await draftReportSummary({
        projectName: str(body.projectName),
        rangeStartLocal: str(body.rangeStartLocal),
        rangeEndLocal: str(body.rangeEndLocal),
        tasks
      });

      if (!summary) {
        res.status(200).json({ success: false, reason: 'draft_unavailable' });
        return;
      }

      res.status(200).json({ success: true, summary });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Render exactly what the client would receive, and send nothing.
   *
   * Same function as the send path uses, deliberately: a preview that could differ from the sent
   * mail would be worse than no preview, because it would be a promise quietly broken.
   */
  router.post('/preview', requireDeviceAuth, async (req: DeviceRequest, res, next) => {
    try {
      const body = (req.body ?? {}) as ReportRequestBody;
      const accountId = str(body.accountId);
      if (!accountId) {
        res.status(400).json({ success: false, reason: 'account_id_required' });
        return;
      }

      const sender = await resolveSender(accountId);
      if (!sender.ok) {
        res.status(200).json({ success: false, reason: sender.reason });
        return;
      }

      // THE REAL PAGE, THE SAME RENDERER THE SEND USES. A preview that could differ from what is
      // stored would be a promise quietly broken, and the preview is mandatory before a first send
      // precisely so the user sees the actual document.
      const page = toReportPage(body, sender.fromName, 'Preview — not yet sent');
      if (!page || page.tasks.length === 0) {
        res.status(400).json({ success: false, reason: 'invalid_report' });
        return;
      }

      res.status(200).json({
        success: true,
        subject: `${page.projectName} — progress report, ${page.period}`,
        html: buildReportPage(page),
        fromName: sender.fromName,
        fromAddress: FROM_ADDRESS,
        replyTo: sender.replyTo
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/send', requireDeviceAuth, async (req: DeviceRequest, res, next) => {
    try {
      const body = (req.body ?? {}) as ReportRequestBody;

      const reportId = str(body.reportId);
      const accountId = str(body.accountId);
      const recipientEmail = str(body.recipientEmail);

      if (!reportId || !accountId || !recipientEmail) {
        res.status(400).json({ success: false, reason: 'missing_required_fields' });
        return;
      }

      if (isSynthetic(recipientEmail) || !looksLikeAddress(recipientEmail)) {
        res.status(200).json({ success: false, reason: 'recipient_invalid' });
        return;
      }

      const sender = await resolveSender(accountId);
      if (!sender.ok) {
        res.status(200).json({ success: false, reason: sender.reason });
        return;
      }

      const sentOn = `Sent ${new Date().toISOString().slice(0, 10)}`;
      const page = toReportPage(body, sender.fromName, sentOn);
      if (!page || page.tasks.length === 0) {
        res.status(400).json({ success: false, reason: 'invalid_report' });
        return;
      }

      // FROZEN HERE, ONCE. The rendered HTML is what gets stored and what the client will open
      // forever; nothing re-renders it later, so a change to the renderer cannot rewrite a page
      // somebody has already read. Regenerating a report writes a new row with a new token.
      const pageToken = newPageToken();
      const pageHtml = buildReportPage(page);
      const reportUrl = reportUrlFor(pageToken);

      // BOUND 2 AND BOUND 3 IN ONE STEP: the row is written before anything is attempted, and the
      // insert fails closed if this id has been claimed before. A duplicate is a retry of something
      // already handled, so we report the truth — not sent again — rather than sending twice.
      const claimed = await claimReportForSend({
        reportId,
        accountId,
        deviceId: str(body.deviceId) || (req.authenticatedDeviceId ?? ''),
        machineId: str(body.machineId),
        projectName: page.projectName,
        rangeStartLocal: str(body.rangeStartLocal),
        rangeEndLocal: str(body.rangeEndLocal),
        recipientEmail,
        recipientName: str(body.recipientName),
        fromName: sender.fromName,
        replyTo: sender.replyTo,
        totalHours: num(body.totalHours),
        daysWorked: Math.trunc(num(body.daysWorked)),
        tasksCompleted: Math.trunc(num(body.tasksCompleted)),
        tasksTotal: Math.trunc(num(body.tasksTotal)),
        linesJson: JSON.stringify(page.tasks),
        dailyJson: JSON.stringify(page.days),
        requestedAtUtc: str(body.requestedAtUtc) || new Date().toISOString(),
        sentAtUtc: '',
        sendState: 'pending',
        sendError: '',
        pageToken,
        pageHtml,
        summary: page.summary
      });

      if (!claimed) {
        res.status(200).json({ success: false, reason: 'already_sent', reportId });
        return;
      }

      // THE EMAIL IS NOW A CARRIER, not the report. Mail clients strip the markup the charts need,
      // so the document lives at the link and this message exists only to get someone there.
      const { subject, html } = buildCarrierEmail({
        projectName: page.projectName,
        rangeStartLocal: str(body.rangeStartLocal),
        rangeEndLocal: str(body.rangeEndLocal),
        reportUrl,
        fromName: sender.fromName
      });

      const sent = await sendEmail({
        to: recipientEmail,
        subject,
        html,
        fromName: sender.fromName,
        fromAddress: FROM_ADDRESS,
        replyTo: sender.replyTo
      });

      // The SERVER's timestamp, which is the one that corresponds to a real delivery and therefore
      // the one that answers a dispute.
      const sentAtUtc = new Date().toISOString();
      await markReportOutcome(reportId, sent, sentAtUtc, sent ? '' : 'resend_rejected');

      if (!sent) {
        console.warn(`[reports] send failed for report ${reportId}`);
        res.status(200).json({ success: false, reason: 'send_failed', reportId });
        return;
      }

      console.log(`[reports] sent report ${reportId} for account ${accountId}`);
      res.status(200).json({ success: true, reportId, sentAtUtc, reportUrl });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Delete one report, server-side. The other half of "delete on both sides" (§12.6.5).
   *
   * The agent calls this FIRST and only removes its own copy once this succeeds, so a failure here
   * leaves the report listed as present on the machine rather than reported as gone. A half-delete
   * that claims success is the `primitive_buckets` failure, and it must not happen twice.
   */
  router.delete('/:reportId', requireDeviceAuth, async (req: DeviceRequest, res, next) => {
    try {
      const reportId = str(req.params.reportId);
      const accountId = str(req.query.accountId);

      if (!reportId || !accountId) {
        res.status(400).json({ success: false, reason: 'missing_required_fields' });
        return;
      }

      const deleted = await deleteSentReport(reportId, accountId);
      if (!deleted) {
        res.status(403).json({ success: false, reason: 'not_your_report' });
        return;
      }

      res.status(200).json({ success: true, reportId });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
