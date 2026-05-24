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
}

/**
 * Send a transactional email via Resend from ari@useporta.com.
 * Returns true if the email was accepted by Resend, false otherwise.
 */
export async function sendEmail(options: SendEmailOptions): Promise<boolean> {
  const client = getResendClient();
  if (!client) {
    return false;
  }

  try {
    const { error } = await client.emails.send({
      from: 'Ari by Porta <ari@useporta.com>',
      to: options.to,
      subject: options.subject,
      html: options.html
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
