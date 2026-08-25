/**
 * The website's download form (2026-08-26).
 *
 * WHY IT LIVES HERE. porta-website ships as a static site, so the `api/` functions in that repo
 * have never executed — `POST /api/send-email` there returns an empty 200 and the page rendered
 * that as success while sending nothing. This service is the same job done on a host that is
 * actually running: the control plane already holds a verified Resend sender, so no new hosting
 * and no second set of mail credentials.
 *
 * It sends two messages: one to us with the answers, and one back to the person so they know the
 * form did something. Both are escaped — every field here is typed by an anonymous stranger.
 */
import { sendEmail } from './emailService.js';

/** The one question the form exists to ask. Kept in one place so both emails agree. */
const UPDATE_QUESTION = 'How they tell clients where things stand today';

/**
 * A product address, not a person's — tests/noPersonalIdentifiersShip.test.ts enforces that, and
 * it is right to. Override with PORTA_DOWNLOAD_REQUEST_TO to route these somewhere else.
 *
 * NOTE: this address must actually be routed for the notification to reach anyone. The
 * confirmation to the submitter does not depend on it.
 */
const DEFAULT_RECIPIENT = 'support@useporta.com';

/**
 * Length ceilings. A real answer to any of these is a short line; anything past these is either a
 * mistake or someone using the form as a pipe into an inbox.
 */
const MAX_EMAIL_LENGTH = 254; // RFC 5321 maximum for a forward-path
const MAX_ROLE_LENGTH = 120;
const MAX_UPDATE_METHOD_LENGTH = 600;

export interface DownloadRequestInput {
  workEmail?: unknown;
  role?: unknown;
  clientUpdateMethod?: unknown;
}

export interface DownloadRequest {
  workEmail: string;
  role: string;
  /** Optional — empty when the visitor skipped the question. */
  clientUpdateMethod: string;
}

export type DownloadRequestValidation =
  | { ok: true; value: DownloadRequest }
  | { ok: false; error: string };

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function validateDownloadRequest(body: DownloadRequestInput | null): DownloadRequestValidation {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body must be valid JSON.' };
  }

  const workEmail = normalizeText(body.workEmail);
  const role = normalizeText(body.role);
  const clientUpdateMethod = normalizeText(body.clientUpdateMethod);

  if (!/^\S+@\S+\.\S+$/.test(workEmail)) {
    return { ok: false, error: 'A valid work email is required.' };
  }

  if (workEmail.length > MAX_EMAIL_LENGTH) {
    return { ok: false, error: 'That email address is too long.' };
  }

  // A newline in either of these would let someone inject a header line if the value were ever
  // used in one. It never is today; rejecting keeps that true if it changes.
  if (/[\r\n]/.test(workEmail)) {
    return { ok: false, error: 'A valid work email is required.' };
  }

  if (!role) {
    return { ok: false, error: 'Please tell us your role.' };
  }

  if (role.length > MAX_ROLE_LENGTH) {
    return { ok: false, error: 'That role is too long.' };
  }

  if (clientUpdateMethod.length > MAX_UPDATE_METHOD_LENGTH) {
    return { ok: false, error: 'That answer is too long.' };
  }

  return { ok: true, value: { workEmail, role, clientUpdateMethod } };
}

export function getDownloadRequestRecipient(): string {
  return process.env.PORTA_DOWNLOAD_REQUEST_TO?.trim() || DEFAULT_RECIPIENT;
}

export function buildNotificationEmail(request: DownloadRequest): { subject: string; html: string } {
  const answer = request.clientUpdateMethod
    ? escapeHtml(request.clientUpdateMethod).replace(/\n/g, '<br />')
    : '<em>(skipped)</em>';

  return {
    subject: `Porta download request: ${request.role}`,
    html: `<!doctype html>
<html>
<body style="margin:0;padding:24px;background:#f9f9f7;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#0b0b0b;">
  <h2 style="margin:0 0 16px 0;font-size:18px;">New Porta download request</h2>
  <p style="margin:0 0 8px 0;font-size:14px;"><strong>Work email:</strong> ${escapeHtml(request.workEmail)}</p>
  <p style="margin:0 0 16px 0;font-size:14px;"><strong>Role:</strong> ${escapeHtml(request.role)}</p>
  <p style="margin:0 0 4px 0;font-size:14px;"><strong>${UPDATE_QUESTION}:</strong></p>
  <p style="margin:0 0 16px 0;font-size:14px;color:#52514e;">${answer}</p>
  <p style="margin:0;font-size:12px;color:#6f6d67;">Submitted ${new Date().toISOString()}</p>
</body>
</html>`
  };
}

export function buildConfirmationEmail(request: DownloadRequest): { subject: string; html: string } {
  return {
    subject: 'Your Porta download request',
    html: `<!doctype html>
<html>
<body style="margin:0;padding:24px;background:#f9f9f7;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#0b0b0b;">
  <h2 style="margin:0 0 16px 0;font-size:18px;">Thanks — we have your request</h2>
  <p style="margin:0 0 16px 0;font-size:14px;line-height:1.6;">
    You asked for the Porta download. We will be in touch shortly with the link.
  </p>
  <p style="margin:0 0 8px 0;font-size:14px;"><strong>Role you gave:</strong> ${escapeHtml(request.role)}</p>
  <p style="margin:0;font-size:13px;color:#52514e;">Reply to this email and it reaches a person.</p>
</body>
</html>`
  };
}

export interface DownloadRequestSendResult {
  ok: boolean;
  notificationSent: boolean;
  confirmationSent: boolean;
}

/**
 * Sends the pair. The notification is the one that matters — if it fails the caller reports a
 * failure, because the request is lost. The confirmation is courtesy: a bounce on a stranger's
 * typo'd address must not lose us the lead we already captured.
 */
export async function sendDownloadRequestEmails(
  request: DownloadRequest
): Promise<DownloadRequestSendResult> {
  const notification = buildNotificationEmail(request);
  const notificationSent = await sendEmail({
    to: getDownloadRequestRecipient(),
    subject: notification.subject,
    html: notification.html,
    fromName: 'Porta',
    replyTo: request.workEmail
  });

  if (!notificationSent) {
    return { ok: false, notificationSent: false, confirmationSent: false };
  }

  const confirmation = buildConfirmationEmail(request);
  const confirmationSent = await sendEmail({
    to: request.workEmail,
    subject: confirmation.subject,
    html: confirmation.html,
    fromName: 'Porta'
  });

  return { ok: true, notificationSent: true, confirmationSent };
}
