# Server-Side Daily Digest — Implementation Plan

## Problem

`DailyDigestReporter.cs` in the Windows agent fires once daily at 19:30 UTC (23:30 Dubai).
If the computer is off at that moment, no digest is sent and no `daily_stats` row is written
to Postgres. A server-side cron cannot fill the gap if the data never arrived.

The fix requires two things working together:
1. **Agent**: write stats to the server periodically during the day, not only at the email send time.
2. **Control plane**: run a cron at 20:30 UTC that sends the email for any account whose stats arrived but whose email hasn't been sent yet.

---

## What Already Exists (do not rebuild)

| Asset | Location | Status |
|---|---|---|
| `buildDigestEmail()` | `src/core/digestEmailBuilder.ts` | Complete — no changes needed |
| `sendEmail()` | `src/core/emailService.ts` | Complete — no changes needed |
| `daily_stats` table | Postgres via `fleetPersistence.ts` | Schema complete — needs one index addition |
| `upsertDailyStats()` | `src/store/dailyStatsStore.ts` | Complete — reused as-is |
| `digest_log` table | Postgres via `fleetPersistence.ts` | Has `account_id` column — needs index |
| `appendDigestLogEntry()` | `src/store/digestLogStore.ts` | Complete — reused as-is |
| `getAccountProfile()` | `src/store/accountStore.ts` | Complete — reused as-is |
| `getUserHistory()` | `src/store/userHistoryStore.ts` | Complete — reused as-is |
| `recomputeUserHistory()` | `src/core/historyService.ts` | Complete — reused as-is |
| `AggregateTimeline()` | `DailyDigestReporter.cs` | Complete — reused for periodic stats |
| Existing `/api/agent/daily-digest` | `agentController.ts` | Keep as primary path — no changes |

---

## Field Mapping: `daily_stats` → `DailyDigestPayload`

The email builder only uses these fields from the payload (confirmed by reading all condition functions A–K):
`trackedSeconds`, `focusSeconds`, `focusQualityScore`, `longestFocusStreakSeconds`,
`fragmentationEpisodeCount`, `socialMediaLoopCount`, `distractionSeconds`,
`overloadEpisodeCount`, `breaksTakenCount`, `breaksSuggestedCount`,
`firstFocusBlockUtc`, `peakPressureUtc`, `avgDistractionEpisodeDurationSeconds`,
`contextSwitchCount`, `dateLocal`.

All are stored in `daily_stats`. Minor name differences to handle at cron time:
- `focusScore` (0–100) → `focusQualityScore` (0–1): divide by 100
- `distractionCount` → `fragmentationEpisodeCount`
- `socialMediaLoops` → `socialMediaLoopCount`
- `longestStreakSeconds` → `longestFocusStreakSeconds`
- `firstFocusUtc` → `firstFocusBlockUtc`
- `mostDistractedHour` (number | null) → `mostDistractedHourLabel` (string): format as `"HH:00-HH:59"` or `"n/a"`

Fields in `DailyDigestPayload` NOT in `daily_stats` (gaming*, passiveConsumption*, contextExcursion*,
developmentSeconds*, etc.): **none of these are used by any email condition** — default them to 0.

---

## Implementation Steps

### Step 1 — Agent: New `DailyStatsReporter.cs` background service
**Repo:** `porta-agent-windows-x64`
**File:** `src/Porta.Agent.Service/Fleet/DailyStatsReporter.cs` (new file)

**What it does:**
- Runs every 2 hours starting from service start
- Re-uses the exact same `AggregateTimeline()` logic already in `DailyDigestReporter.cs`
- Builds a `DailyStatsPayload` (a smaller struct — just the aggregated numbers, no email metadata)
- POSTs to the new `/api/agent/daily-stats` endpoint
- No minimum time gate (posts even if only 5 minutes of data — server takes whatever it has)
- Fully fire-and-forget: any failure is silently swallowed, same pattern as `ControlPlaneReporter`

**Why every 2 hours:**
If the user starts work at 9:00 AM Dubai (05:00 UTC), stats are written to the server at
07:00, 09:00, 11:00, 13:00, 15:00, 17:00, 19:00 UTC. Even if the computer shuts down at
18:00 UTC (22:00 Dubai), the 17:00 UTC write has today's data on the server.

**Register in `AgentService.cs`:**
Add `services.AddHostedService<DailyStatsReporter>();` alongside the existing reporters.

---

### Step 2 — Control plane: New `POST /api/agent/daily-stats` endpoint
**Repo:** `porta-control-plane`
**File:** `src/api/controllers/agentController.ts` (add route to existing router)

**What it does:**
- Accepts the same payload shape as `/api/agent/daily-digest` (agent reuses the same struct)
- Calls `upsertDailyStats()` — exactly what the existing digest handler already does
- Calls `recomputeUserHistory()` — keeps user_history current
- Does **not** send email
- Does **not** write to `digest_log`
- Returns `202 { accepted: true }`

**Why not merge into `/api/agent/daily-digest`:** The email endpoint has a minimum 1-hour gate
and writes to `digest_log`. The stats endpoint has no gate and must not mark the day as "sent".

---

### Step 3 — Control plane: DB index addition
**File:** `src/store/fleetPersistence.ts`

Add two indexes in the `CREATE TABLE` migration block (using `IF NOT EXISTS` — safe to add):

```sql
CREATE INDEX IF NOT EXISTS idx_digest_log_account_date
  ON digest_log (account_id, date_local);

CREATE INDEX IF NOT EXISTS idx_daily_stats_date
  ON daily_stats (date_local);
```

The first index lets the cron cheaply ask "has this account received a fired=true digest today?"
The second lets the cron cheaply scan all accounts with stats for a given date.

---

### Step 4 — Control plane: Two new store functions

**File:** `src/store/digestLogStore.ts` — add:
```
wasDigestSentForAccount(accountId: string, dateLocal: string): Promise<boolean>
```
Queries: `SELECT 1 FROM digest_log WHERE account_id = $1 AND date_local = $2 AND fired = true LIMIT 1`

**File:** `src/store/dailyStatsStore.ts` — add:
```
getAccountsWithQualifyingStatsForDate(dateLocal: string): Promise<DailyStats[]>
```
Queries: `SELECT * FROM daily_stats WHERE date_local = $1 AND tracked_seconds >= 3600`

---

### Step 5 — Control plane: New `digestCronService.ts`
**File:** `src/core/digestCronService.ts` (new file)

**Export:** `runDailyDigestCron(): Promise<void>`

**Logic:**
1. Compute `dateLocal` = today's date in Dubai timezone (UTC+4): `new Date(Date.now() + 4*60*60*1000)` formatted as `YYYY-MM-DD`
2. Call `getAccountsWithQualifyingStatsForDate(dateLocal)` → array of `DailyStats`
3. For each stats row:
   a. Call `wasDigestSentForAccount(accountId, dateLocal)` — skip if already sent
   b. Load `getAccountProfile(accountId)` — skip if no profile or no email
   c. Load `getUserHistory(accountId)`
   d. Map `DailyStats` → `DailyDigestPayload` using the field mapping table above
   e. Call `buildDigestEmail(payload, baseUrl + '/launch', history, firstName)`
   f. Call `sendEmail(...)` 
   g. Call `appendDigestLogEntry({ machineId: 'server-cron', accountId, dateLocal, ... fired: sent })`
   h. Call `recomputeUserHistory(accountId)` (stats already exist — just refresh history)
4. Log summary: how many sent, how many skipped (already sent), how many failed

**Base URL for the launch link:** Read from `process.env.PORTA_CONTROL_PLANE_URL` (same env var
that exists on Render), fall back to `https://porta-control-plane.onrender.com`.

---

### Step 6 — Control plane: Schedule the cron
**File:** `src/main.ts`

**No new npm dependency needed.** Use a simple `setInterval` loop that checks the clock:

```typescript
// Run at 20:30 UTC daily
function scheduleDailyDigestCron() {
  setInterval(async () => {
    const now = new Date();
    if (now.getUTCHours() === 20 && now.getUTCMinutes() >= 30 && now.getUTCMinutes() < 35) {
      await runDailyDigestCron();
    }
  }, 60 * 1000); // check every minute
}
scheduleDailyDigestCron();
```

**Why 20:30 UTC (00:30 Dubai):** Gives 1 hour of buffer after the agent's primary 19:30 UTC trigger.
Any machine still on at 19:30 UTC will have already sent the digest via the agent path. The cron
catches only machines that were off.

**On-startup catch-up:** If it's between 20:30 UTC and 23:59 UTC when the server starts (e.g. after a Render restart), run the cron once immediately on startup to cover any missed window.

---

## What Does NOT Change

- `DailyDigestReporter.cs` — kept exactly as-is. Agent path remains the primary sender.
- `buildDigestEmail` — no changes.
- `sendEmail` — no changes.
- `/api/agent/daily-digest` endpoint — no changes.
- `digest_log` schema — no schema change (account_id column already exists, just adding an index).
- `daily_stats` schema — no changes.

---

## Deduplication Logic (ensuring no double-send)

The agent path writes `digest_log` with `fired = true` when it successfully sends.
The cron checks `wasDigestSentForAccount()` before sending.

Order of events on a normal day (computer on at 19:30 UTC):
1. 19:30 UTC: agent sends → `digest_log` written with `fired = true`
2. 20:30 UTC: cron runs → `wasDigestSentForAccount` returns `true` → cron skips → no duplicate

Order of events when computer is off at 19:30 UTC:
1. 17:00 UTC: agent's 2-hour stats push → `daily_stats` written (no email, no digest_log entry)
2. 19:30 UTC: computer is off → nothing happens
3. 20:30 UTC: cron runs → `wasDigestSentForAccount` returns `false` → cron sends → logged with `machineId = 'server-cron'`

---

## Files Changed Summary

| File | Change |
|---|---|
| `porta-agent-windows-x64/src/Porta.Agent.Service/Fleet/DailyStatsReporter.cs` | New file |
| `porta-agent-windows-x64/src/Porta.Agent.Service/AgentService.cs` | Register `DailyStatsReporter` as hosted service |
| `porta-control-plane/src/api/controllers/agentController.ts` | Add `POST /api/agent/daily-stats` route |
| `porta-control-plane/src/store/fleetPersistence.ts` | Add 2 indexes |
| `porta-control-plane/src/store/digestLogStore.ts` | Add `wasDigestSentForAccount()` |
| `porta-control-plane/src/store/dailyStatsStore.ts` | Add `getAccountsWithQualifyingStatsForDate()` |
| `porta-control-plane/src/core/digestCronService.ts` | New file |
| `porta-control-plane/src/main.ts` | Schedule cron |

**Total: 8 files. No new npm packages. No new Render services.**
