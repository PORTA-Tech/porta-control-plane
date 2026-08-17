import { Router } from 'express';
import { requireDeviceAuth, type DeviceRequest } from '../middleware/deviceAuth.js';
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

export function createReportsController(): Router {
  const router = Router();

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

      const payload = toEmailPayload(body, sender.fromName);
      if (!payload) {
        res.status(400).json({ success: false, reason: 'invalid_report' });
        return;
      }

      const { subject, html } = buildReportEmail(payload);
      res.status(200).json({
        success: true,
        subject,
        html,
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

      const payload = toEmailPayload(body, sender.fromName);
      if (!payload) {
        res.status(400).json({ success: false, reason: 'invalid_report' });
        return;
      }

      // BOUND 2 AND BOUND 3 IN ONE STEP: the row is written before anything is attempted, and the
      // insert fails closed if this id has been claimed before. A duplicate is a retry of something
      // already handled, so we report the truth — not sent again — rather than sending twice.
      const claimed = await claimReportForSend({
        reportId,
        accountId,
        deviceId: str(body.deviceId) || (req.authenticatedDeviceId ?? ''),
        machineId: str(body.machineId),
        projectName: payload.projectName,
        rangeStartLocal: payload.rangeStartLocal,
        rangeEndLocal: payload.rangeEndLocal,
        recipientEmail,
        recipientName: str(body.recipientName),
        fromName: sender.fromName,
        replyTo: sender.replyTo,
        totalHours: payload.totalHours,
        daysWorked: payload.daysWorked,
        tasksCompleted: payload.tasksCompleted,
        tasksTotal: payload.tasksTotal,
        linesJson: JSON.stringify(payload.lines),
        dailyJson: JSON.stringify(payload.daily),
        requestedAtUtc: str(body.requestedAtUtc) || new Date().toISOString(),
        sentAtUtc: '',
        sendState: 'pending',
        sendError: ''
      });

      if (!claimed) {
        res.status(200).json({ success: false, reason: 'already_sent', reportId });
        return;
      }

      const { subject, html } = buildReportEmail(payload);

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
      res.status(200).json({ success: true, reportId, sentAtUtc });
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
