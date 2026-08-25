import * as supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The weekly digest's send path. Yadin's decision, 2026-08-25: Monday 07:00 local, Sunday's daily
// still sends, and the weekly gets its OWN dedup log rather than sharing the daily's.
//
// The last test in this file is the one that matters most: it proves the two logs are independent.
// Sharing `digest_log` would key both cadences on a DATE, and the day they ever landed together one
// would silently suppress the other — a bug that presents as "the email just didn't arrive".

vi.mock('../src/core/emailService.js', () => ({
  sendEmail: vi.fn().mockResolvedValue(true),
}));

const request = (supertest as unknown as { default: typeof supertest }).default as unknown as typeof import('supertest');

const { createApp } = await import('../src/app.js');
const { upsertAccountProfile, clearAccountStoreForTests } = await import('../src/store/accountStore.js');
const { wasWeeklyDigestSentForAccount, __resetWeeklyDigestLogForTests } =
  await import('../src/store/weeklyDigestLogStore.js');
const { wasDigestSentForAccount } = await import('../src/store/digestLogStore.js');
const { sendEmail } = await import('../src/core/emailService.js');

const app = createApp();

// A Monday morning send, for the week that ended the day before.
const MONDAY_MORNING = new Date('2026-07-13T03:00:00Z');
const WEEK_START = '2026-07-06';
const WEEK_END = '2026-07-12';

async function seedAccount(accountId: string, email: string): Promise<void> {
  await upsertAccountProfile({
    accountId,
    displayName: 'Weekly Tester',
    firstName: 'Weekly',
    primaryEmail: email,
    emailVerified: true,
    avatarUrl: null,
    status: 'active',
    authProvider: 'local',
    lastLoginAt: '2026-07-13T02:00:00.000Z',
    createdAt: '2026-07-01T09:00:00.000Z',
    updatedAt: '2026-07-13T02:00:00.000Z',
  } as Parameters<typeof upsertAccountProfile>[0]);
}

const L = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function weeklyBody(accountId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accountId,
    deviceId: 'device-1',
    machineId: 'machine-1',
    weekStartLocal: WEEK_START,
    weekEndLocal: WEEK_END,
    timezoneOffsetMinutes: 240,
    reportedAtUtc: MONDAY_MORNING.toISOString(),
    plannedCount: 12,
    finishedCount: 8,
    trackedSeconds: 40 * 3600,
    focusSeconds: 28 * 3600,
    awaySeconds: 6 * 3600,
    days: L.map((label, i) => ({
      dateLocal: `2026-07-${String(6 + i).padStart(2, '0')}`,
      label,
      focusSeconds: i === 6 ? 0 : 4 * 3600,
      worked: i !== 6,
    })),
    finished: [{ title: 'Ship the thing', project: 'PORTA', seconds: 5400 }],
    carried: [{ title: 'The other thing', project: 'Admin', seconds: 3600, daysOpen: 4 }],
    projects: [{ name: 'PORTA', seconds: 20 * 3600 }],
    ariTake: 'Eight of twelve closed.',
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(MONDAY_MORNING);
  clearAccountStoreForTests();
  __resetWeeklyDigestLogForTests();
  (sendEmail as unknown as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/agent/weekly-digest', () => {
  it('sends a well-formed week and marks it fired', async () => {
    const accountId = 'acct-weekly-ok';
    await seedAccount(accountId, 'weekly@porta.test');

    const res = await request(app).post('/api/agent/weekly-digest').send(weeklyBody(accountId));

    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(await wasWeeklyDigestSentForAccount(accountId, WEEK_END)).toBe(true);

    const arg = (sendEmail as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { subject: string; html: string };
    expect(arg.subject).toContain('8 of 12 finished');
    expect(arg.html).toContain('You planned 12 things.');
  });

  it('sends once per account per week, however many times it is asked', async () => {
    // The agent's own guard is in-memory, so a restart re-POSTs; two linked machines would both
    // send. The server is the only place that can see every sender.
    const accountId = 'acct-weekly-dupe';
    await seedAccount(accountId, 'dupe@porta.test');

    const first = await request(app).post('/api/agent/weekly-digest').send(weeklyBody(accountId));
    const second = await request(app).post('/api/agent/weekly-digest').send(weeklyBody(accountId));
    // a different machine on the same account must not get through either
    const third = await request(app)
      .post('/api/agent/weekly-digest')
      .send(weeklyBody(accountId, { machineId: 'machine-2' }));

    expect(first.body.sent).toBe(true);
    expect(second.body.sent).toBe(false);
    expect(second.body.reason).toBe('already_sent');
    expect(third.body.sent).toBe(false);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('refuses a week whose dates are not real dates, rather than guessing one', async () => {
    const accountId = 'acct-weekly-bad';
    await seedAccount(accountId, 'bad@porta.test');

    for (const bad of [{ weekEndLocal: '12 July' }, { weekStartLocal: '' }, { weekEndLocal: '2026-7-12' }]) {
      const res = await request(app).post('/api/agent/weekly-digest').send(weeklyBody(accountId, bad));
      expect(res.status).toBe(400);
    }
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('refuses a week that runs backwards', async () => {
    const accountId = 'acct-weekly-rev';
    await seedAccount(accountId, 'rev@porta.test');
    const res = await request(app)
      .post('/api/agent/weekly-digest')
      .send(weeklyBody(accountId, { weekStartLocal: '2026-07-12', weekEndLocal: '2026-07-06' }));
    expect(res.status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('refuses a week that has not finished yet', async () => {
    const accountId = 'acct-weekly-future';
    await seedAccount(accountId, 'future@porta.test');
    const res = await request(app)
      .post('/api/agent/weekly-digest')
      .send(weeklyBody(accountId, { weekStartLocal: '2026-09-07', weekEndLocal: '2026-09-13' }));
    expect(res.body.sent).toBe(false);
    expect(res.body.reason).toBe('future_week_end');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('does not send to an account with no profile, and records why', async () => {
    const res = await request(app).post('/api/agent/weekly-digest').send(weeklyBody('acct-nobody'));
    expect(res.body.sent).toBe(false);
    expect(res.body.reason).toBe('no_profile');
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await wasWeeklyDigestSentForAccount('acct-nobody', WEEK_END)).toBe(false);
  });

  it('keeps its own log: a sent weekly never marks the daily as sent', async () => {
    // THE POINT OF THE SEPARATE TABLE. Sunday's daily still goes out under Yadin's decision, so the
    // weekly must not be able to claim that day — in either direction.
    const accountId = 'acct-weekly-isolated';
    await seedAccount(accountId, 'isolated@porta.test');

    await request(app).post('/api/agent/weekly-digest').send(weeklyBody(accountId));

    expect(await wasWeeklyDigestSentForAccount(accountId, WEEK_END)).toBe(true);
    // the daily's log knows nothing about it — not for the week-end date, nor any day in the week
    expect(await wasDigestSentForAccount(accountId, WEEK_END)).toBe(false);
    expect(await wasDigestSentForAccount(accountId, WEEK_START)).toBe(false);
  });
});
