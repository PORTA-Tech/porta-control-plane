import * as supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { resetDownloadRequestRateLimitForTests, resolveClientIp } from '../src/core/downloadRequestRateLimit.js';
import {
  buildConfirmationEmail,
  buildNotificationEmail,
  getDownloadRequestRecipient,
  validateDownloadRequest
} from '../src/core/downloadRequestService.js';
import type { SendEmailOptions } from '../src/core/emailService.js';

// ESM namespaces are frozen, so the send is replaced at module level rather than spied on.
const sendEmail = vi.hoisted(() => vi.fn<[SendEmailOptions], Promise<boolean>>());
vi.mock('../src/core/emailService.js', () => ({ sendEmail }));

const request = (supertest as unknown as { default: typeof supertest }).default as unknown as typeof import('supertest');
const app = createApp();

const VALID = {
  workEmail: 'someone@example.com',
  role: 'Freelance developer',
  clientUpdateMethod: 'A long email every Friday night'
};

/** Distinct source IPs keep one test's rate-limit budget out of another's. */
function post(body: unknown, ip = '203.0.113.10') {
  return request(app).post('/api/download-request').set('x-forwarded-for', ip).send(body as object);
}

describe('POST /api/download-request', () => {
  beforeEach(() => {
    resetDownloadRequestRateLimitForTests();
    process.env.RESEND_API_KEY = 'test-key';
    delete process.env.PORTA_DOWNLOAD_REQUEST_TO;
    delete process.env.PORTA_DOWNLOAD_REQUEST_MAX_PER_IP_PER_HOUR;
    delete process.env.PORTA_DOWNLOAD_REQUEST_MAX_PER_HOUR;
    sendEmail.mockReset();
    sendEmail.mockResolvedValue(true);
  });

  afterEach(() => {
    delete process.env.RESEND_API_KEY;
  });

  it('accepts a valid request and sends both emails', async () => {
    const response = await post(VALID);

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(typeof response.body.message).toBe('string');
    expect(response.body.message.length).toBeGreaterThan(0);
    expect(sendEmail).toHaveBeenCalledTimes(2);

    const [notification, confirmation] = sendEmail.mock.calls.map((call) => call[0]);
    expect(notification.to).toBe('support@useporta.com');
    expect(notification.replyTo).toBe(VALID.workEmail);
    expect(notification.subject).toContain('Freelance developer');
    expect(confirmation.to).toBe(VALID.workEmail);
  });

  it('treats the third field as optional', async () => {
    const response = await post({ workEmail: VALID.workEmail, role: VALID.role });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    const notification = sendEmail.mock.calls[0][0];
    expect(notification.html).toContain('(skipped)');
  });

  it('always answers with a JSON object, never an empty body', async () => {
    // The page now rejects any non-object response, because a static host answering an empty 200
    // used to render as success while nothing was sent.
    for (const [body, expected] of [
      [VALID, 200],
      [{ role: 'x' }, 400],
      [{ workEmail: 'not-an-email', role: 'x' }, 400]
    ] as const) {
      resetDownloadRequestRateLimitForTests();
      const response = await post(body);
      expect(response.status).toBe(expected);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(typeof response.body).toBe('object');
      expect(response.body).not.toBeNull();
      expect(typeof response.body.ok).toBe('boolean');
    }
  });

  it('rejects a missing or malformed email with a code the page understands', async () => {
    const response = await post({ workEmail: 'nope', role: 'Developer' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(typeof response.body.error).toBe('string');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('rejects a missing role', async () => {
    const response = await post({ workEmail: VALID.workEmail, role: '   ' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('invalid_request');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('rejects over-long fields rather than mailing them on', async () => {
    const long = await post({ workEmail: VALID.workEmail, role: 'x'.repeat(121) });
    expect(long.status).toBe(400);

    resetDownloadRequestRateLimitForTests();
    const longAnswer = await post({
      workEmail: VALID.workEmail,
      role: 'Developer',
      clientUpdateMethod: 'y'.repeat(601)
    });
    expect(longAnswer.status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('escapes HTML in every field that reaches the email', async () => {
    await post({
      workEmail: 'evil@example.com',
      role: '<img src=x onerror=alert(1)>',
      clientUpdateMethod: '</p><script>alert(2)</script>'
    });

    const notification = sendEmail.mock.calls[0][0];
    expect(notification.html).not.toContain('<script>');
    expect(notification.html).not.toContain('<img src=x');
    expect(notification.html).toContain('&lt;img src=x');
    expect(notification.html).toContain('&lt;script&gt;');
  });

  it('rate limits per IP and reports how long to wait', async () => {
    process.env.PORTA_DOWNLOAD_REQUEST_MAX_PER_IP_PER_HOUR = '2';
    const ip = '198.51.100.7';

    expect((await post(VALID, ip)).status).toBe(200);
    expect((await post(VALID, ip)).status).toBe(200);

    const blocked = await post(VALID, ip);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // two allowed requests, each sending a notification and a confirmation — and nothing for the
    // blocked third, which is the point: a rejected request must not cost an email.
    expect(sendEmail).toHaveBeenCalledTimes(4);
  });

  it('does not let one visitor exhaust another visitor budget', async () => {
    process.env.PORTA_DOWNLOAD_REQUEST_MAX_PER_IP_PER_HOUR = '1';

    expect((await post(VALID, '198.51.100.1')).status).toBe(200);
    expect((await post(VALID, '198.51.100.1')).status).toBe(429);
    expect((await post(VALID, '198.51.100.2')).status).toBe(200);
  });

  it('applies a global ceiling as well', async () => {
    process.env.PORTA_DOWNLOAD_REQUEST_MAX_PER_IP_PER_HOUR = '50';
    process.env.PORTA_DOWNLOAD_REQUEST_MAX_PER_HOUR = '2';

    expect((await post(VALID, '203.0.113.1')).status).toBe(200);
    expect((await post(VALID, '203.0.113.2')).status).toBe(200);

    const blocked = await post(VALID, '203.0.113.3');
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('rate_limited');
  });

  it('reports a send failure instead of claiming success', async () => {
    sendEmail.mockResolvedValue(false);

    const response = await post(VALID);
    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({ ok: false, code: 'send_failed' });
  });

  it('still succeeds when only the courtesy confirmation fails', async () => {
    sendEmail.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const response = await post(VALID);
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it('survives the mail client throwing', async () => {
    sendEmail.mockRejectedValue(new Error('resend exploded'));

    const response = await post(VALID);
    expect(response.status).toBe(502);
    expect(response.body.code).toBe('send_failed');
  });

  it('says so when email is not configured, rather than pretending', async () => {
    delete process.env.RESEND_API_KEY;

    const response = await post(VALID);
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ ok: false, code: 'email_not_configured' });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('allows the website origin through CORS preflight', async () => {
    const response = await request(app)
      .options('/api/download-request')
      .set('Origin', 'https://useporta.com')
      .set('Access-Control-Request-Method', 'POST');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://useporta.com');
    expect(response.headers['access-control-allow-headers']).toContain('Content-Type');
  });

  it('keeps the website origin even when CORS_ALLOWED_ORIGINS is set to something else', async () => {
    const previous = process.env.CORS_ALLOWED_ORIGINS;
    process.env.CORS_ALLOWED_ORIGINS = 'https://porta-operations-console.onrender.com';
    try {
      const scoped = createApp();
      const response = await request(scoped)
        .options('/api/download-request')
        .set('Origin', 'https://useporta.com')
        .set('Access-Control-Request-Method', 'POST');
      expect(response.headers['access-control-allow-origin']).toBe('https://useporta.com');
    } finally {
      if (previous === undefined) {
        delete process.env.CORS_ALLOWED_ORIGINS;
      } else {
        process.env.CORS_ALLOWED_ORIGINS = previous;
      }
    }
  });
});

describe('download request helpers', () => {
  it('reads the recipient from env, defaulting to the owner inbox', () => {
    delete process.env.PORTA_DOWNLOAD_REQUEST_TO;
    expect(getDownloadRequestRecipient()).toBe('support@useporta.com');

    process.env.PORTA_DOWNLOAD_REQUEST_TO = 'someone-else@example.com';
    expect(getDownloadRequestRecipient()).toBe('someone-else@example.com');
    delete process.env.PORTA_DOWNLOAD_REQUEST_TO;
  });

  it('takes the first hop from x-forwarded-for', () => {
    expect(resolveClientIp({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' })).toBe('1.2.3.4');
    expect(resolveClientIp({ 'x-forwarded-for': ['5.6.7.8'] })).toBe('5.6.7.8');
    expect(resolveClientIp({}, '9.9.9.9')).toBe('9.9.9.9');
    expect(resolveClientIp({})).toBe('unknown');
  });

  it('rejects a newline smuggled into the email field', () => {
    const result = validateDownloadRequest({ workEmail: 'a@b.co\nBcc: x@y.co', role: 'Developer' });
    expect(result.ok).toBe(false);
  });

  it('builds both emails with the role in them', () => {
    const value = { workEmail: 'a@b.co', role: 'Consultant', clientUpdateMethod: '' };
    expect(buildNotificationEmail(value).subject).toContain('Consultant');
    expect(buildConfirmationEmail(value).html).toContain('Consultant');
  });
});
