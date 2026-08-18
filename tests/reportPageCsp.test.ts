import * as supertest from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  __resetSentReportMemoryStore,
  claimReportForSend,
  markReportOutcome,
  type SentReportRecord
} from '../src/store/sentReportStore.js';

/**
 * 2026-08-18. The report page went out to a real client rendering as unstyled text.
 *
 * The global middleware sets `default-src 'none'`, which is right for every API route and fatal
 * for the one route that serves a self-contained HTML document: the browser received correct
 * markup and dropped the inline <style>, the inline style= attributes and the tooltip <script>.
 *
 * These tests pin both halves of the fix so it cannot regress: /r/:token must relax style and
 * script, and every other route must not.
 */

const request = (supertest as unknown as { default: typeof supertest }).default as unknown as typeof import('supertest');
const app = createApp();

const TOKEN = 'test-token-abcdefghijklmnopqrstuvwxyz0123456789';
const PAGE_HTML = '<!doctype html><html><head><style>body{color:red}</style></head>'
  + '<body><div style="color:blue" data-tip="x">hi</div><script>void 0;</script></body></html>';

function record(overrides: Partial<SentReportRecord> = {}): SentReportRecord {
  return {
    reportId: 'report-csp-1', accountId: 'acct-1', deviceId: 'dev-1', machineId: 'mach-1',
    projectName: 'Test project', rangeStartLocal: '2026-08-12', rangeEndLocal: '2026-08-18',
    recipientEmail: 'client@example.com', recipientName: 'Client', fromName: 'Sender',
    replyTo: 'sender@example.com', totalHours: 1, daysWorked: 1, tasksCompleted: 1, tasksTotal: 1,
    linesJson: '[]', dailyJson: '[]', requestedAtUtc: '2026-08-18T00:00:00.000Z', sentAtUtc: '',
    sendState: 'pending', sendError: '', pageToken: TOKEN, pageHtml: PAGE_HTML, summary: 's',
    ...overrides
  };
}

function directives(header: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const space = trimmed.indexOf(' ');
    map.set(
      space === -1 ? trimmed : trimmed.slice(0, space),
      space === -1 ? '' : trimmed.slice(space + 1).trim()
    );
  }
  return map;
}

describe('report page CSP', () => {
  beforeEach(async () => {
    __resetSentReportMemoryStore();
    await claimReportForSend(record());
    await markReportOutcome('report-csp-1', true, '2026-08-18T00:00:01.000Z', '');
  });

  it('serves the frozen page with inline style and script allowed', async () => {
    const response = await request(app).get(`/r/${TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.text).toBe(PAGE_HTML);

    const csp = directives(response.headers['content-security-policy']);
    expect(csp.get('default-src')).toBe("'none'");
    expect(csp.get('style-src')).toBe("'unsafe-inline'");
    expect(csp.get('script-src')).toBe("'unsafe-inline'");
    expect(csp.get('frame-ancestors')).toBe("'none'");
    expect(csp.get('base-uri')).toBe("'none'");
    expect(csp.get('form-action')).toBe("'none'");
  });

  it('permits no external origin from the report page', async () => {
    const response = await request(app).get(`/r/${TOKEN}`);
    const header = response.headers['content-security-policy'] ?? '';

    // Every source in the policy is either 'none', 'unsafe-inline', or data:. Nothing that could
    // fetch from, or beacon out to, another host.
    expect(header).not.toMatch(/https?:/);
    expect(header).not.toMatch(/\*/);
  });

  it('still marks the page noindex and uncacheable', async () => {
    const response = await request(app).get(`/r/${TOKEN}`);

    expect(response.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive, nosnippet');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('leaves the strict default in place for API routes', async () => {
    const response = await request(app).get('/health');

    const csp = directives(response.headers['content-security-policy']);
    expect(csp.get('default-src')).toBe("'none'");
    expect(csp.has('style-src')).toBe(false);
    expect(csp.has('script-src')).toBe(false);
  });

  it('does not relax anything for an unknown token', async () => {
    const response = await request(app).get(`/r/${'z'.repeat(43)}`);

    expect(response.status).toBe(404);
    expect(response.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive, nosnippet');
  });
});
