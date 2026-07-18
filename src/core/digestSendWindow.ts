// Part 4 — guards for the /api/agent/daily-digest route.
//
// The agent's DailyDigestReporter only legitimately POSTs between 19:30 UTC (23:30 Dubai) and
// midnight UTC (the gate re-arms on the next UTC day). The confirmed failure mode this protects
// against: a machine that slept mid-send woke the next MORNING and delivered a stale digest at
// 10:50 local, whose digest_log row then suppressed that evening's real digest as "already
// sent". Old agent builds in the fleet can still do this, so the server enforces the window too.

// 19:25 UTC — five minutes of clock-skew grace before the agent's 19:30 gate.
export const AGENT_DIGEST_WINDOW_OPEN_MINUTES = 19 * 60 + 25;
// 00:15 UTC — grace for a request already in flight when the UTC day rolls over.
export const AGENT_DIGEST_WINDOW_CLOSE_MINUTES = 15;

export function isWithinAgentDigestSendWindow(now: Date = new Date()): boolean {
  const minutesUtc = now.getUTCHours() * 60 + now.getUTCMinutes();
  return minutesUtc >= AGENT_DIGEST_WINDOW_OPEN_MINUTES || minutesUtc <= AGENT_DIGEST_WINDOW_CLOSE_MINUTES;
}

const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;

/** Today's calendar date in Dubai (UTC+4) as "YYYY-MM-DD". */
export function dubaiTodayDate(now: Date = new Date()): string {
  return new Date(now.getTime() + DUBAI_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * A digest stamped with a Dubai date later than "today in Dubai" is impossible except through
 * the wrong-day stamping bug — such a row would poison the account+date dedup key for tomorrow.
 */
export function isFutureDubaiDate(dateLocal: string, now: Date = new Date()): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateLocal) && dateLocal > dubaiTodayDate(now);
}
