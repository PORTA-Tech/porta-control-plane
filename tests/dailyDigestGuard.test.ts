import * as supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Part 3a — the near-zero "sent" guard, verified at the /api/agent/daily-digest handler. A payload
// with near-zero tracked time must be neither sent NOR marked fired=true (a phantom fired=true row
// would later suppress the real evening digest as "already sent"). A real day sends and marks the
// day. Dedup remains keyed on account + local date (see digestLogStore.test.ts for that property).
//
// sendEmail is mocked so "was a real digest delivered?" is deterministic without Resend, and the
// system clock is pinned inside the agent send window so the Part-4 window guard passes.

vi.mock('../src/core/emailService.js', () => ({
  sendEmail: vi.fn().mockResolvedValue(true),
}));

const request = (supertest as unknown as { default: typeof supertest }).default as unknown as typeof import('supertest');

// Imported after the mock is registered.
const { createApp } = await import('../src/app.js');
const { upsertAccountProfile, clearAccountStoreForTests } = await import('../src/store/accountStore.js');
const { wasDigestSentForAccount } = await import('../src/store/digestLogStore.js');
const { sendEmail } = await import('../src/core/emailService.js');

const app = createApp();

// 20:00 UTC on 2026-07-16 is inside the agent send window (>= 19:25 UTC), and "today in Dubai" is
// 2026-07-17, so a dateLocal of 2026-07-16 is neither future-stamped nor out-of-window.
const IN_WINDOW = new Date('2026-07-16T20:00:00Z');
const DATE_LOCAL = '2026-07-16';

async function seedAccount(accountId: string, email: string): Promise<void> {
  await upsertAccountProfile({
    accountId,
    displayName: 'Digest Tester',
    firstName: 'Digest',
    primaryEmail: email,
    emailVerified: true,
    avatarUrl: null,
    status: 'active',
    authProvider: 'local',
    lastLoginAt: '2026-07-16T10:00:00.000Z',
    createdAt: '2026-07-16T09:00:00.000Z',
    updatedAt: '2026-07-16T10:00:00.000Z',
  } as Parameters<typeof upsertAccountProfile>[0]);
}

function digestBody(accountId: string, trackedSeconds: number): Record<string, unknown> {
  return {
    accountId,
    deviceId: 'device-1',
    machineId: 'machine-1',
    dateLocal: DATE_LOCAL,
    timezoneOffsetMinutes: 240,
    reportedAtUtc: IN_WINDOW.toISOString(),
    trackedSeconds,
    focusSeconds: Math.round(trackedSeconds * 0.6),
    focusQualityScore: 0.6,
    longestFocusStreakSeconds: 1800,
    distractionSeconds: 300,
    awaySeconds: 600,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(IN_WINDOW);
  clearAccountStoreForTests();
  (sendEmail as unknown as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/agent/daily-digest near-zero guard (Part 3a)', () => {
  it('near-zero tracked time is NOT sent and does NOT write fired=true', async () => {
    const accountId = 'acct-nearzero';
    await seedAccount(accountId, 'nearzero@porta.test');

    const res = await request(app).post('/api/agent/daily-digest').send(digestBody(accountId, 30));

    // The handler short-circuits (skipped) — no email, no fired=true row.
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await wasDigestSentForAccount(accountId, DATE_LOCAL)).toBe(false);
  });

  it('a real day is sent and marks the day fired=true', async () => {
    const accountId = 'acct-realday';
    await seedAccount(accountId, 'realday@porta.test');

    const res = await request(app).post('/api/agent/daily-digest').send(digestBody(accountId, 4 * 3600));

    expect(res.status).toBe(202);
    expect(res.body.sent).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(await wasDigestSentForAccount(accountId, DATE_LOCAL)).toBe(true);
  });
});
