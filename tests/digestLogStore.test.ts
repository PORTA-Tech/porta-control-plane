import { describe, it, expect } from 'vitest';
import { appendDigestLogEntry, wasDigestSentForAccount } from '../src/store/digestLogStore.js';

// B1 — one digest per ACCOUNT per day. The duplicate-email fix on /api/agent/daily-digest rests on
// wasDigestSentForAccount, so the properties it depends on are pinned here.
//
// The non-obvious one: the log row is keyed by MACHINE + date, but dedup matches by ACCOUNT + date.
// That is what makes a restarted agent (same machine) AND a second linked machine both resolve to
// "already sent" instead of mailing the user twice.
describe('digestLogStore dedup (B1)', () => {
  const entry = (over: Partial<Parameters<typeof appendDigestLogEntry>[0]> = {}) => ({
    machineId: 'machine-a',
    accountId: 'acct-1',
    dateLocal: '2026-07-16',
    trackedSeconds: 7200,
    fired: true,
    failureReason: null,
    sentAtUtc: new Date().toISOString(),
    ...over,
  });

  it('reports not-sent before anything is logged', async () => {
    expect(await wasDigestSentForAccount('acct-never', '2026-07-16')).toBe(false);
  });

  it('reports sent once a fired entry exists for that account and date', async () => {
    await appendDigestLogEntry(entry({ accountId: 'acct-sent' }));
    expect(await wasDigestSentForAccount('acct-sent', '2026-07-16')).toBe(true);
  });

  it('is scoped to the date — a send yesterday does not suppress today', async () => {
    await appendDigestLogEntry(entry({ accountId: 'acct-dates', dateLocal: '2026-07-15' }));
    expect(await wasDigestSentForAccount('acct-dates', '2026-07-15')).toBe(true);
    expect(await wasDigestSentForAccount('acct-dates', '2026-07-16')).toBe(false);
  });

  it('is scoped to the account — one user does not suppress another', async () => {
    await appendDigestLogEntry(entry({ accountId: 'acct-x' }));
    expect(await wasDigestSentForAccount('acct-y', '2026-07-16')).toBe(false);
  });

  it('catches a SECOND machine on the same account (dedup is per account, not per machine)', async () => {
    await appendDigestLogEntry(entry({ accountId: 'acct-multi', machineId: 'machine-a' }));
    // machine-b now POSTs for the same account+date — it must be suppressed.
    expect(await wasDigestSentForAccount('acct-multi', '2026-07-16')).toBe(true);
  });

  it('does not treat a FAILED send as sent, so the next attempt may retry', async () => {
    await appendDigestLogEntry(
      entry({ accountId: 'acct-failed', fired: false, failureReason: 'send_failed' })
    );
    expect(await wasDigestSentForAccount('acct-failed', '2026-07-16')).toBe(false);
  });
});
