import { describe, expect, it } from 'vitest';
import {
  isWithinAgentDigestSendWindow,
  isFutureDubaiDate,
  dubaiTodayDate,
  hasReportableTrackedTime,
  DIGEST_MIN_TRACKED_SECONDS,
} from '../src/core/digestSendWindow.js';

// Part 4 — the confirmed phantom-digest incident: an agent digest POSTed at 06:50 UTC (10:50 in
// Dubai, the "morning digest"), stamped with that day's date, whose fired=true row then made the
// evening's real digest skip as "already sent". These guards make both halves impossible.
describe('isWithinAgentDigestSendWindow', () => {
  it('accepts the normal agent send at 19:30 UTC', () => {
    expect(isWithinAgentDigestSendWindow(new Date('2026-07-17T19:30:05Z'))).toBe(true);
  });

  it('accepts a late agent start at 22:00 UTC (agent was off at 19:30)', () => {
    expect(isWithinAgentDigestSendWindow(new Date('2026-07-17T22:00:00Z'))).toBe(true);
  });

  it('accepts the clock-skew grace just before 19:30', () => {
    expect(isWithinAgentDigestSendWindow(new Date('2026-07-17T19:25:00Z'))).toBe(true);
    expect(isWithinAgentDigestSendWindow(new Date('2026-07-17T19:24:59Z'))).toBe(false);
  });

  it('accepts an in-flight request just past midnight UTC', () => {
    expect(isWithinAgentDigestSendWindow(new Date('2026-07-18T00:10:00Z'))).toBe(true);
    expect(isWithinAgentDigestSendWindow(new Date('2026-07-18T00:16:00Z'))).toBe(false);
  });

  it('rejects the 06:50 UTC morning fire', () => {
    expect(isWithinAgentDigestSendWindow(new Date('2026-07-17T06:50:51Z'))).toBe(false);
  });

  it('rejects mid-day sends', () => {
    expect(isWithinAgentDigestSendWindow(new Date('2026-07-17T12:00:00Z'))).toBe(false);
  });
});

describe('dubaiTodayDate / isFutureDubaiDate', () => {
  it('rolls to the next Dubai day at 20:00 UTC', () => {
    expect(dubaiTodayDate(new Date('2026-07-17T19:59:00Z'))).toBe('2026-07-17');
    expect(dubaiTodayDate(new Date('2026-07-17T20:00:00Z'))).toBe('2026-07-18');
  });

  it('flags a wrong-day stamp (tomorrow in Dubai) as future', () => {
    // 21:51 UTC on the 13th is 01:51 Dubai on the 14th — a digest stamped 06-15 would be future.
    const now = new Date('2026-06-13T21:51:53Z');
    expect(isFutureDubaiDate('2026-06-15', now)).toBe(true);
    // The observed phantom stamp (2026-06-14) equals "today in Dubai" at that moment; it is the
    // send-window guard, not this one, that blocks the morning variant.
    expect(isFutureDubaiDate('2026-06-14', now)).toBe(false);
    expect(isFutureDubaiDate('2026-06-13', now)).toBe(false);
  });

  it('ignores malformed dates', () => {
    expect(isFutureDubaiDate('not-a-date', new Date())).toBe(false);
    expect(isFutureDubaiDate('', new Date())).toBe(false);
  });
});

// Part 3a — the near-zero / low-activity guard. Below the threshold, a digest must neither be sent
// nor mark the day sent, so an essentially-empty payload can never phantom-suppress the real digest.
describe('hasReportableTrackedTime (Part 3a)', () => {
  it('rejects near-zero tracked time (a misbehaving/old agent’s empty digest)', () => {
    expect(hasReportableTrackedTime(0)).toBe(false);
    expect(hasReportableTrackedTime(30)).toBe(false);       // 30 seconds
    expect(hasReportableTrackedTime(5 * 60)).toBe(false);   // 5 minutes
  });

  it('accepts a real day (at or above the threshold)', () => {
    expect(hasReportableTrackedTime(DIGEST_MIN_TRACKED_SECONDS)).toBe(true);
    expect(hasReportableTrackedTime(4 * 3600)).toBe(true);
  });

  it('rejects non-finite / non-number tracked seconds defensively', () => {
    expect(hasReportableTrackedTime(Number.NaN)).toBe(false);
    expect(hasReportableTrackedTime(Number.POSITIVE_INFINITY)).toBe(false);
    expect(hasReportableTrackedTime(undefined as unknown as number)).toBe(false);
  });
});
