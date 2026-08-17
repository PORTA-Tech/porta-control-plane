import { Resend } from 'resend';

let resendClient: Resend | null = null;

function getResendClient(): Resend | null {
  if (resendClient) {
    return resendClient;
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[emailService] RESEND_API_KEY not set — email sending disabled.');
    return null;
  }
  resendClient = new Resend(apiKey);
  return resendClient;
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  /**
   * Step 10 (2026-08-14) — the sender, for client reports.
   *
   * Omitted, this stays the nightly digest's `ari@useporta.com`. A client report overrides it with
   * the USER'S OWN NAME and `reports@useporta.com`, plus a reply-to of the user's own address, so
   * the client reads the user's name first and hitting reply reaches them (spec §6).
   *
   * `reports@` rather than `ari@` deliberately: mail providers score sending addresses separately,
   * so a spam mark on the nightly digest must not travel to client reports, or the other way round.
   */
  fromName?: string;
  fromAddress?: string;
  replyTo?: string;
}

/**
 * Send a transactional email via Resend.
 * Returns true if the email was accepted by Resend, false otherwise.
 */
export async function sendEmail(options: SendEmailOptions): Promise<boolean> {
  const client = getResendClient();
  if (!client) {
    return false;
  }

  try {
    // The digest's sender remains the default, so nothing about that path changes.
    const fromName = (options.fromName ?? '').trim() || 'Ari by Porta';
    const fromAddress = (options.fromAddress ?? '').trim() || 'ari@useporta.com';

    // A display name containing a quote or an angle bracket would break the header, and a name is
    // whatever a user typed at registration. Strip rather than reject: refusing to send a report
    // because of a punctuation mark in a name is worse than sending it without the mark.
    const safeName = fromName.replace(/["<>\r\n]/g, '').trim() || 'Ari by Porta';
    const replyTo = (options.replyTo ?? '').trim();

    const { error } = await client.emails.send({
      from: `${safeName} <${fromAddress}>`,
      to: options.to,
      subject: options.subject,
      html: options.html,
      ...(replyTo ? { replyTo } : {})
    });

    if (error) {
      console.error('[emailService] Resend error:', error.message);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[emailService] Failed to send email:', err instanceof Error ? err.message : String(err));
    return false;
  }
}
