# Ari Messaging System — Complete Execution Plan
**For Claude Code · All Platforms · All Users from Day 1 MSI Install**

---

## How to Read This Plan

This plan is split into two phases executed in strict order:

**Phase 1 — Data Layer**: Build every data input the messaging system needs. Nothing in Phase 2 can be built without Phase 1 existing first.

**Phase 2 — Messaging System**: Build the email observation, widget triggers, and Control Center bubble using the data from Phase 1.

**Golden rule throughout**: No existing field, table, function, or behavior changes. Every addition is purely additive — new fields, new tables, new functions alongside what already exists.

**Works for all users from day 1**: Every condition in Phase 2 has a defined minimum data requirement. Users with fewer days than the minimum see the next available condition, all the way down to the fallback which requires zero history and works from the very first digest.

---

## Phase 1 — Data Layer

### 1A. New Fields to Add to the Daily Digest Payload (Windows Agent)

These values are already computed during `DailyDigestReporter.TrySendDigestAsync` (which aggregates the timeline) but are not included in the payload sent to the control plane. Add them to `DailyDigestReportPayload` in `FleetContracts.cs` and compute them in `DailyDigestReporter.AggregateTimeline`.

**Fields to add to `DailyDigestReportPayload` (all nullable, all optional with defaults):**

```csharp
// When did the first sustained focus block start? (UTC ISO string, null if no focus today)
string? FirstFocusBlockUtc = null,

// When did pressure peak? (UTC ISO string of the snapshot with highest pressure)
string? PeakPressureUtc = null,

// Average duration of each distraction episode in seconds
double AvgDistractionEpisodeDurationSeconds = 0d,

// Total number of app/focus context switches in the session
int ContextSwitchCount = 0,

// Duration of the pre-distraction focus block before the longest distraction episode (seconds)
// Used by widget recovery nudge
double PreLongestDistractionFocusSeconds = 0d,

// Total passive consumption seconds (non-gaming, non-social entertainment)
// (already partially computed, confirm it's in the payload)
double PassiveConsumptionSeconds = 0d,
```

**How to compute them in `AggregateTimeline`:**

- `FirstFocusBlockUtc`: First snapshot where `FocusStrength > 0.5` AND `attentionSegmentKind == "focus"`. Take its `TimestampUtc`.
- `PeakPressureUtc`: Snapshot with highest `OverloadLikelihood`. Take its `TimestampUtc`.
- `AvgDistractionEpisodeDurationSeconds`: Total `distractionSeconds / fragmentationEpisodeCount`. If `fragmentationEpisodeCount == 0`, use `0`.
- `ContextSwitchCount`: Count transitions where `attentionSegmentKind` changes between consecutive snapshots.
- `PreLongestDistractionFocusSeconds`: Find the longest contiguous distraction block. Count focus seconds immediately before it started.

**Also add to the control plane's `normalizeMachineSummaryReport` equivalent for digests** — these fields go into the digest POST body, so `agentController.ts` needs to read them from `req.body` the same way it reads `trackedSeconds` etc.

---

### 1B. Add `firstName` to Account Profile (Control Plane)

**File: `src/store/accountStore.ts`**

The account profile must carry the user's first name. Add `firstName: string | null` to the account profile object stored per user. Default to `null` for existing accounts.

**File: `src/api/controllers/authController.ts` or wherever account creation happens**

Accept `firstName` during registration/onboarding and store it. If no name is provided during sign-up, it stays null — the messaging system always falls back to `"You"` when firstName is null.

Do not make `firstName` required anywhere. It is always optional.

---

### 1C. New Table: `daily_stats` (Control Plane — Postgres)

This is the most important table in Phase 1. Every time a digest fires successfully, write a row. This is what all history computations are built on.

**Migration — add alongside existing `digest_log` table:**

```sql
CREATE TABLE IF NOT EXISTS daily_stats (
  account_id       TEXT        NOT NULL,
  date_local       TEXT        NOT NULL,  -- "YYYY-MM-DD" in user's local time
  day_of_week      INTEGER     NOT NULL,  -- 0=Sunday, 1=Monday ... 6=Saturday
  tracked_seconds  REAL        NOT NULL DEFAULT 0,
  focus_seconds    REAL        NOT NULL DEFAULT 0,
  focus_pct        REAL        NOT NULL DEFAULT 0,  -- focus_seconds / tracked_seconds * 100
  focus_score      REAL        NOT NULL DEFAULT 0,  -- 0-100 (focusQualityScore * 100)
  longest_streak_seconds REAL  NOT NULL DEFAULT 0,
  distraction_seconds  REAL    NOT NULL DEFAULT 0,
  distraction_count    INTEGER NOT NULL DEFAULT 0,
  avg_distraction_duration_seconds REAL NOT NULL DEFAULT 0,
  context_switch_count INTEGER  NOT NULL DEFAULT 0,
  overload_events  INTEGER     NOT NULL DEFAULT 0,
  breaks_taken     INTEGER     NOT NULL DEFAULT 0,
  breaks_suggested INTEGER     NOT NULL DEFAULT 0,
  social_media_loops INTEGER   NOT NULL DEFAULT 0,
  social_media_seconds REAL    NOT NULL DEFAULT 0,
  away_seconds     REAL        NOT NULL DEFAULT 0,
  pressure_avg_pct REAL        NOT NULL DEFAULT 0,  -- pressureLevel * 100 averaged
  first_focus_utc  TEXT,                            -- null if no focus that day
  peak_pressure_utc TEXT,
  most_distracted_hour INTEGER,                     -- 0-23, null if no distraction
  created_at_utc   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, date_local)
);

CREATE INDEX IF NOT EXISTS idx_daily_stats_account_date
  ON daily_stats (account_id, date_local DESC);

CREATE INDEX IF NOT EXISTS idx_daily_stats_account_dow
  ON daily_stats (account_id, day_of_week);
```

**When to write**: In `agentController.ts`, after `sendEmail()` succeeds (or even if it sends `skipped: true` due to under 1h), write a row. This way every day with any tracking is recorded, not just days an email was sent. The row captures the raw daily stats regardless of whether the digest email fired.

---

### 1D. New Table: `user_history` (Control Plane — Postgres)

This table stores the computed baselines per user. It is recomputed every time a new `daily_stats` row is written (at digest time). It is what the email observation function reads.

```sql
CREATE TABLE IF NOT EXISTS user_history (
  account_id           TEXT PRIMARY KEY,
  days_of_data         INTEGER NOT NULL DEFAULT 0,
  consecutive_streak   INTEGER NOT NULL DEFAULT 0,  -- days in a row with tracked_seconds >= 3600
  focus_trend          TEXT    NOT NULL DEFAULT 'stable',  -- 'improving' | 'stable' | 'declining'

  -- 30-day rolling averages
  avg_focus_pct        REAL    NOT NULL DEFAULT 0,
  avg_focus_score      REAL    NOT NULL DEFAULT 0,
  avg_tracked_min      REAL    NOT NULL DEFAULT 0,
  avg_streak_min       REAL    NOT NULL DEFAULT 0,
  avg_pressure_pct     REAL    NOT NULL DEFAULT 0,
  avg_distraction_count REAL   NOT NULL DEFAULT 0,
  avg_distraction_dur_min REAL NOT NULL DEFAULT 0,
  avg_context_switches REAL    NOT NULL DEFAULT 0,
  avg_breaks_taken     REAL    NOT NULL DEFAULT 0,
  avg_breaks_suggested REAL    NOT NULL DEFAULT 0,

  -- Personal bests (all-time)
  best_focus_pct       REAL    NOT NULL DEFAULT 0,
  best_focus_score     REAL    NOT NULL DEFAULT 0,
  best_streak_min      REAL    NOT NULL DEFAULT 0,
  best_tracked_min     REAL    NOT NULL DEFAULT 0,
  best_streak_date     TEXT,   -- "YYYY-MM-DD" of the best streak
  best_focus_score_date TEXT,  -- "YYYY-MM-DD" of best focus score

  -- Per day-of-week averages (stored as JSON object: {"0": 45.2, "1": 62.1, ...})
  dow_avg_focus_pct    TEXT    NOT NULL DEFAULT '{}',
  dow_avg_tracked_min  TEXT    NOT NULL DEFAULT '{}',
  dow_avg_focus_score  TEXT    NOT NULL DEFAULT '{}',

  -- Behavioral patterns (require 14+ days to be reliable)
  weak_hour            INTEGER,  -- 0-23, null until 14+ days
  strong_window_start  INTEGER,  -- hour 0-23, null until 14+ days
  strong_window_end    INTEGER,  -- hour 0-23, null until 14+ days

  updated_at_utc       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

### 1E. New Service: `historyService.ts` (Control Plane)

**File: `src/core/historyService.ts`**

This service is called once after every `daily_stats` write. It recomputes `user_history` from the `daily_stats` table.

```typescript
export async function recomputeUserHistory(accountId: string): Promise<void>
```

**What it computes:**

**`days_of_data`**: `SELECT COUNT(*) FROM daily_stats WHERE account_id = $1`

**`consecutive_streak`**: Starting from today's date, count backward how many consecutive days have `tracked_seconds >= 3600`. Stop at the first gap.

**`focus_trend`**: Compare average `focus_pct` of the last 7 days vs the 7 days before that. If last 7 days avg > prior 7 days avg by 5+ percentage points → "improving". If lower by 5+ points → "declining". Otherwise → "stable". Requires at least 7 days of data — return "stable" if fewer.

**30-day rolling averages**: `SELECT AVG(focus_pct), AVG(...) FROM daily_stats WHERE account_id = $1 AND date_local >= (today - 30 days) ORDER BY date_local DESC`

**Personal bests**: `SELECT MAX(focus_pct), MAX(focus_score), MAX(longest_streak_seconds / 60) ...` across all time. Store the date of each best separately.

**Per day-of-week averages**: `SELECT day_of_week, AVG(focus_pct), AVG(tracked_seconds / 60), AVG(focus_score) FROM daily_stats WHERE account_id = $1 GROUP BY day_of_week`. Minimum 2 occurrences per day to include — skip days with only 1 data point. Store as JSON string.

**`weak_hour`** (requires 14+ days): For each day in daily_stats, the `most_distracted_hour` column gives the hour. Take the mode (most common hour) across all days. If no single hour dominates (tie), take the earliest. Only compute if `days_of_data >= 14`.

**`strong_window_start/end`** (requires 14+ days): From the first_focus_utc timestamps and focus quality per day, find the 2-hour window (e.g., 9am–11am) where `focus_score` is consistently highest. Group by hour-of-day across all days, take the hour with highest average `focus_score`, then `strong_window_start = that_hour`, `strong_window_end = that_hour + 2`. Only compute if `days_of_data >= 14`.

**Safety**: All computations must handle empty results gracefully. If no data, write defaults. Never throw — catch all errors and log, then continue.

---

### 1F. Message Rotation Tracker (Control Plane)

**File: `src/store/messageRotationStore.ts`**

Stores which message templates have been shown to each user in the last 7 days, to prevent exact repetition.

```sql
CREATE TABLE IF NOT EXISTS message_rotation (
  account_id    TEXT    NOT NULL,
  message_key   TEXT    NOT NULL,  -- e.g. "digest:streak_A_template_1"
  shown_at_utc  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, message_key)
);

CREATE INDEX IF NOT EXISTS idx_message_rotation_account
  ON message_rotation (account_id, shown_at_utc DESC);
```

**Two functions needed:**

```typescript
// Returns true if this template was shown within the last 7 days
export async function wasMessageShownRecently(accountId: string, messageKey: string): Promise<boolean>

// Records that this template was shown
export async function recordMessageShown(accountId: string, messageKey: string): Promise<void>
```

Purge rows older than 7 days on each write (add `DELETE FROM message_rotation WHERE shown_at_utc < NOW() - INTERVAL '7 days'` before insert).

---

### 1G. Widget Session State (Windows Agent — In-Memory)

**File: new `Porta.UserAgent/Input/UserAgentSessionState.cs`**

This class lives in the UserAgent process and resets at the start of each day. It tracks what has already been shown in the current session so nothing repeats.

```csharp
internal sealed class UserAgentSessionState
{
    private readonly HashSet<int> _firedFocusMilestones = new(); // 15, 30, 45, 60, 90
    private bool _firstFocusMessageSent;
    private DateTimeOffset _lastToastSentUtc = DateTimeOffset.MinValue;
    private DateTimeOffset _sessionDate;

    // Pre-distraction focus duration — set when distraction episode starts
    public double PreDistractionFocusSeconds { get; set; }
    public bool InDistractionEpisode { get; private set; }
    public DateTimeOffset DistractionStartedUtc { get; private set; }

    // Returns true if this milestone has not been fired in this session
    public bool TryFireMilestone(int minutes) => _firedFocusMilestones.Add(minutes);

    // 8-minute suppression between any toasts
    public bool CanShowToast(DateTimeOffset nowUtc) =>
        (nowUtc - _lastToastSentUtc).TotalMinutes >= 8;

    public void RecordToastShown(DateTimeOffset nowUtc) => _lastToastSentUtc = nowUtc;

    public bool FirstFocusMessageSent => _firstFocusMessageSent;
    public void MarkFirstFocusMessageSent() => _firstFocusMessageSent = true;

    public void MarkDistractionStarted(double preFocusSeconds, DateTimeOffset nowUtc)
    {
        InDistractionEpisode = true;
        PreDistractionFocusSeconds = preFocusSeconds;
        DistractionStartedUtc = nowUtc;
    }

    public void MarkDistractionEnded() => InDistractionEpisode = false;

    // Reset at start of each new calendar day
    public void ResetIfNewDay(DateTimeOffset nowUtc)
    {
        if (DateOnly.FromDateTime(nowUtc.LocalDateTime) != DateOnly.FromDateTime(_sessionDate.LocalDateTime))
        {
            _firedFocusMilestones.Clear();
            _firstFocusMessageSent = false;
            _lastToastSentUtc = DateTimeOffset.MinValue;
            InDistractionEpisode = false;
            PreDistractionFocusSeconds = 0;
            _sessionDate = nowUtc;
        }
    }
}
```

---

## Phase 2 — Messaging System

Everything in Phase 2 reads from the data built in Phase 1. Do not start Phase 2 until Phase 1 is deployed and the `daily_stats` and `user_history` tables exist.

---

### 2A. Email Digest — New Observation System

**File: `src/core/digestEmailBuilder.ts`**

Replace `buildAriObservation()` entirely. Do not change anything else in this file — subject line, HTML structure, sections, helper functions all stay as-is.

**New function signature:**

```typescript
function buildAriObservation(p: DailyDigestPayload, h: UserHistory | null, firstName: string | null): string
```

`UserHistory` is the shape of the `user_history` table row. `firstName` comes from `getAccountProfile()`. Both can be null — handle gracefully everywhere.

**The scored condition system — evaluate ALL, pick highest score that fires:**

Each condition function returns `{ score: number; message: string } | null`. `null` means the condition does not fire. After evaluating all conditions, pick the non-null result with the highest score. If tie, pick the one with a personal comparison (personal best beats day-of-week beats global). If all scores are zero or all return null, use the fallback (Condition J).

---

**Condition A — Streak / Trend (score: 90)**
Minimum data: 3 days. Fires when: `h.consecutive_streak >= 3` OR `h.focus_trend === 'improving'`.

```typescript
// Template A1 - streak
`${name}, ${h.consecutive_streak} days in a row with focus above your average. 
Something is working — keep the chain intact.`

// Template A2 - trend
`Focus has climbed for ${trendDays} consecutive days. 
Your 7-day average is now ${weekAvg}% — up from ${priorAvg}% the week before.`

// Template A3 - combined
`${h.consecutive_streak} days tracked in a row. 
Your focus average this week is ${weekAvg}% — your best 7-day stretch this month.`
```

---

**Condition B — Personal Record (score: 85)**
Minimum data: 5 days. Fires when: today's `focusQualityScore * 100 > h.best_focus_score` OR `longestFocusStreakSeconds / 60 > h.best_streak_min` OR `focusPct > h.best_focus_pct`.

```typescript
// Template B1 - best focus score
`${name}, focus score of ${today_score} today — your best recorded. 
Previous best was ${h.best_focus_score} on ${formatDate(h.best_focus_score_date)}.`

// Template B2 - best streak
`${today_streak}min uninterrupted focus — your longest recorded. 
Ari has been watching for ${h.days_of_data} days. This is the best run yet.`

// Template B3 - best focus pct
`${today_focus_pct}% focus rate today — personal record. 
Your previous best was ${h.best_focus_pct}%.`
```

---

**Condition C — Day-of-Week Comparison (score: 80)**
Minimum data: 4 occurrences of the same weekday. Check `dow_avg_focus_pct[dayOfWeek]`. Fires when: `|today_focus_pct - dow_avg| >= 15`.

```typescript
// Template C1 - above average
`${name}, your ${today_focus_pct}% focus rate today is your best ${dayName} this month. 
${dayName}s average ${dow_avg}% for you.`

// Template C2 - below average
`Below your ${dayName} average by ${diff}%. 
You usually hit ${dow_avg}% on ${dayName}s — today was ${today_focus_pct}%.`

// Template C3 - quiet day variant
`Quiet ${dayName}. ${today_tracked_min}min tracked versus your usual ${dow_avg_tracked_min}min. 
Not every ${dayName} needs to be a push.`
```

---

**Condition D — Pressure Pattern (score: 75)**
Minimum data: 7 days. Fires when: `pressurePct > h.avg_pressure_pct + 15` OR (`h.weak_hour` is set AND `peakPressureUtc` hour matches `h.weak_hour`).

```typescript
// Template D1 - above average pressure
`Pressure ran ${diff}% above your normal today — average ${pressurePct}% versus your usual ${h.avg_pressure_pct}%. 
${contextSwitchCount} context switches contributed. Wind down properly tonight.`

// Template D2 - pressure peaked at weak hour
`Pressure peaked at ${peakHour}:00 — your historically difficult window. 
${diff}% above your personal average. That pattern has shown up before.`

// Template D3 - name variant for high pressure
`${name}, high pressure day. ${pressurePct}% average versus your usual ${h.avg_pressure_pct}%. 
Your recovery quality tonight will shape tomorrow's start.`
```

---

**Condition E — Focus Quality vs Quantity Split (score: 70)**
Minimum data: 0 days (works from day 1, uses today's numbers only). Fires when: `focusPct >= 50 AND focusQualityScore * 100 < 45` OR `focusPct < 30 AND focusQualityScore * 100 >= 70`.

```typescript
// Template E1 - time in seat but not present
`${today_focus_pct}% focus time today, but quality score only ${today_score}. 
Time in seat, but not fully there. Common after high-pressure or fragmented days.`

// Template E2 - short but deep
`Short day — only ${today_tracked_min}min tracked — but focus quality was ${qualityGrade}. 
${today_focus_min}min of actual deep work. That counts.`

// Template E3 - high quality low time
`Only ${today_tracked_min}min tracked, but your focus score was ${today_score}. 
When you were working, you were really working.`
```

---

**Condition F — Distraction Pattern (score: 65)**
Minimum data: 5 days. Fires when: `distractionCount > h.avg_distraction_count * 1.3` OR `avgDistractionEpisodeDurationSeconds / 60 > h.avg_distraction_dur_min * 1.3` OR `socialMediaLoopCount >= 5`.

```typescript
// Template F1 - more episodes than average
`${distractionCount} distraction episodes today — above your usual ${h.avg_distraction_count}. 
Average drift was ${avg_distraction_min}min. Total focus lost: ${total_lost_min}min.`

// Template F2 - social media loops
`You returned to social media ${socialMediaLoopCount} times today. 
Your typical is ${h.avg_social_loops ?? 'lower'}. That's a pattern worth watching.`

// Template F3 - fast recovery
`${distractionCount} distraction episodes today, but you recovered from each in under ${avg_distraction_min}min — faster than your average of ${h.avg_distraction_dur_min}min.`
```

---

**Condition G — Break Compliance (score: 60)**
Minimum data: 0 days. Fires when: `breaksTakenCount === 0 AND trackedMinutes >= 90 AND breaksSuggestedCount >= 1` OR `breaksTakenCount === breaksSuggestedCount AND breaksSuggestedCount >= 2`.

```typescript
// Template G1 - no breaks taken
`No breaks across ${today_tracked_h}h of work. 
Ari suggested ${breaksSuggested}. The last ${decay_min}min showed the cost.`

// Template G2 - all breaks taken
`You took every break Ari suggested today — ${breaksTaken} of ${breaksSuggested}. 
That kind of compliance is rare. Your afternoon focus reflected it.`

// Template G3 - partial compliance
`${breaksTaken} of ${breaksSuggested} breaks taken. 
The ${missed} you skipped coincided with your pressure peak at ${peakHour}:00.`
```

---

**Condition H — Recovery After Below-Average Day (score: 55)**
Minimum data: 2 days. Fires when: `today_focus_score > h.avg_focus_score AND yesterday_focus_score < h.avg_focus_score`. (Requires storing yesterday's focus score, available from `daily_stats` — query the most recent row before today.)

```typescript
// Template H1
`Back above your average after yesterday. 
${today_score} today — your mean is ${h.avg_focus_score}. Good recovery.`

// Template H2
`${today_focus_pct}% focus today, up from yesterday. 
Above your average for the first time this week.`
```

---

**Condition I — Strong Window Recognition (score: 50)**
Minimum data: 14 days. `h.strong_window_start` must be non-null. Fires when: `firstFocusBlockUtc` hour falls within `[strong_window_start, strong_window_end]`.

```typescript
// Template I1
`You used your strongest window — ${strongWindowLabel}. 
That block produced ${window_focus_min}min of your best focus today.`

// Template I2
`Your ${strongWindowLabel} window is consistently your sharpest. 
Today it delivered — ${window_focus_min}min of deep work in that block.`
```

---

**Condition J — Quiet Day Fallback (score: 10)**
Minimum data: 0 days. Fires when: no other condition fires OR `days_of_data < 3`. This is the guaranteed message — always produces something specific and useful.

```typescript
// Template J1 - has some history
`Quiet day — ${today_tracked_min}min tracked. Your usual is ${avg_tracked_min}min. 
Ari is watching. Come back tomorrow.`

// Template J2 - has streak even on quiet day
`${name}, ${today_tracked_min}min today. ${h.consecutive_streak} days tracked in a row — 
that consistency matters more than any single session.`

// Template J3 - very new user (< 3 days)
`${today_tracked_min}min tracked today. 
Ari has ${h.days_of_data} day${h.days_of_data === 1 ? '' : 's'} of your data — the picture sharpens every session.`

// Template J4 - zero or minimal data
`${today_tracked_min}min of activity tracked. 
Keep showing up and Ari will get more specific about what it sees.`
```

---

**Template selection — prevent repetition:**

```typescript
async function selectTemplate(
  condition: string,
  templates: string[],
  accountId: string
): Promise<{ text: string; key: string }> {
  for (let i = 0; i < templates.length; i++) {
    const key = `digest:${condition}:t${i}`;
    const used = await wasMessageShownRecently(accountId, key);
    if (!used) {
      await recordMessageShown(accountId, key);
      return { text: templates[i], key };
    }
  }
  // All templates used recently — pick the oldest used one
  // (This handles users who get the same condition every day)
  const key = `digest:${condition}:t0`;
  await recordMessageShown(accountId, key);
  return { text: templates[0], key };
}
```

---

**Subject line — make it specific too:**

Currently: `Your Ari daily digest — Monday, 19 May 2025`

Replace with a subject that hints at the content:

```typescript
function buildSubjectLine(p: DailyDigestPayload, h: UserHistory | null): string {
  if (h && h.consecutive_streak >= 3) return `${h.consecutive_streak} days in a row — ${dateDisplay}`;
  if (todayIsPersonalBest) return `Personal best today — ${dateDisplay}`;
  if (p.focusQualityScore >= 0.8) return `Strong focus day — ${dateDisplay}`;
  if (p.overloadEpisodeCount >= 3) return `High pressure day — ${dateDisplay}`;
  if (p.breaksTakenCount === 0 && p.trackedSeconds >= 5400) return `No breaks today — ${dateDisplay}`;
  return `Your Ari digest — ${dateDisplay}`;  // fallback unchanged
}
```

---

**Where to call all of this in `agentController.ts`:**

In the `POST /agent/daily-digest` handler, after validating the account:
1. Load `UserHistory` from `user_history` table for this `accountId`
2. Load `firstName` from `getAccountProfile(accountId).firstName`
3. Pass both into `buildDigestEmail(payload, launchUrl)` — update the function signature to accept them
4. After `sendEmail()` succeeds: write to `daily_stats`, then call `recomputeUserHistory(accountId)`
5. Even if email skipped (under 1h): still write to `daily_stats` if `trackedSeconds > 0`, then recompute history

---

### 2B. Widget / Toast Messages (Windows Agent)

**File: `Porta.UserAgent/Interventions/UserCommunicationRouter.cs`**

Currently `TryBuildRecentEventToast` always returns false. Replace it with real event-to-toast logic.

Also add a new method `ResolveProactiveToast` that is called from the `UserAgentHost` main loop at appropriate moments (driven by the new `UserAgentSessionState` class from Phase 1G).

**The `UserAgentHost` must pass the current snapshot state into these methods** so the router knows current focus duration, pressure level, and distraction state.

---

**What to pass from UserAgentHost:**

Create a new lightweight struct:

```csharp
internal sealed record UserAgentLiveContext(
    double CurrentFocusDurationSeconds,   // sustained focus so far in current episode
    double CurrentPressurePct,            // current pressure level 0-100
    int RecentContextSwitchCount,         // switches in last 5 minutes
    DateTimeOffset NowUtc,
    bool IsInDistractionEpisode,
    double PreDistractionFocusSeconds,    // set when distraction started
    double TodayFocusMinutes,             // total focus so far today
    double TodayTrackedMinutes,           // total tracked so far today
    int BreaksSuggestedToday,
    bool HasHadABreakToday,
    double SessionElapsedMinutes,         // time since first activity today
    int? WeakHour,                        // from user history, null if unknown
    double AvgStreakMin,                  // from user history, 0 if unknown
    string? FirstName);                  // from user history, null if unknown
```

This context is assembled in the UserAgentHost main loop from the local API snapshot + session state. It does NOT require network calls — all data is already in memory in the service process.

**Important**: The UserAgent does not have direct access to `user_history`. The values `WeakHour`, `AvgStreakMin`, `FirstName` need to be fetched from the control plane. The agent already sends heartbeats — add a new lightweight endpoint `GET /api/agent/user-context?accountId=...` that returns just these three values. Cache them in memory, refresh once per day. If the call fails, all three are null — all messages fall back gracefully.

---

**TRIGGER 1: Focus run milestone**

Called from UserAgentHost when sustained focus duration crosses a threshold.

```csharp
public static UserCommunicationToast? ResolveFocusMilestoneToast(
    UserAgentLiveContext ctx,
    UserAgentSessionState sessionState)
{
    int[] milestones = [15, 30, 45, 60, 90];
    int currentMinutes = (int)(ctx.CurrentFocusDurationSeconds / 60);

    foreach (int milestone in milestones.Reverse())
    {
        if (currentMinutes < milestone) continue;
        if (!sessionState.TryFireMilestone(milestone)) continue;
        if (!sessionState.CanShowToast(ctx.NowUtc)) return null;

        string name = ctx.FirstName ?? "You";
        string msg = milestone switch
        {
            15 => $"{name}, 15 minutes clean. Ari is watching.",
            30 => "30 minutes. You're in it now.",
            45 => ctx.AvgStreakMin > 0
                ? $"45min — above your average streak of {(int)ctx.AvgStreakMin}min."
                : "45 minutes uninterrupted. Keep going.",
            60 => $"{name} — 60 minutes. Your best run today. Don't stop.",
            90 => "90 minutes. Strong session.",
            _ => string.Empty
        };

        if (string.IsNullOrEmpty(msg)) return null;
        sessionState.RecordToastShown(ctx.NowUtc);
        return new UserCommunicationToast(
            Key: $"milestone:{milestone}",
            Title: "Ari",
            Message: msg);
    }
    return null;
}
```

---

**TRIGGER 2: Pressure rising**

```csharp
public static UserCommunicationToast? ResolvePressureToast(
    UserAgentLiveContext ctx,
    UserAgentSessionState sessionState,
    double avgPressurePct)  // from user history, 0 if unknown
{
    if (!sessionState.CanShowToast(ctx.NowUtc)) return null;

    bool aboveAverage = avgPressurePct > 0 && ctx.CurrentPressurePct > avgPressurePct + 15;
    bool rapidSwitching = ctx.RecentContextSwitchCount >= 3;

    if (!aboveAverage && !rapidSwitching) return null;

    string name = ctx.FirstName ?? string.Empty;
    string msg = (aboveAverage, rapidSwitching) switch
    {
        (true, true) => $"{(string.IsNullOrEmpty(name) ? "Hey" : name)}, {ctx.RecentContextSwitchCount} switches and pressure at {(int)ctx.CurrentPressurePct}%. Slow down.",
        (true, false) => $"Pressure at {(int)ctx.CurrentPressurePct}% — {(int)(ctx.CurrentPressurePct - avgPressurePct)}% above your usual.",
        (false, true) => $"{ctx.RecentContextSwitchCount} switches in the last few minutes. Pressure building.",
        _ => string.Empty
    };

    if (string.IsNullOrEmpty(msg)) return null;
    sessionState.RecordToastShown(ctx.NowUtc);
    return new UserCommunicationToast(Key: "pressure_rising", Title: "Ari", Message: msg);
}
```

---

**TRIGGER 3: Recovery nudge (most important)**

Called when a distraction episode ends (user returns to keyboard after being away).

```csharp
public static UserCommunicationToast? ResolveRecoveryNudgeToast(
    UserAgentLiveContext ctx,
    UserAgentSessionState sessionState)
{
    if (!ctx.IsInDistractionEpisode) return null;
    // This fires when the distraction JUST ENDED — called once per episode end
    if (!sessionState.CanShowToast(ctx.NowUtc)) return null;

    int preMin = (int)(sessionState.PreDistractionFocusSeconds / 60);
    if (preMin < 5) return null;  // don't nudge if barely any focus before the drift

    string name = ctx.FirstName ?? string.Empty;
    string msg = preMin >= 30
        ? $"{(string.IsNullOrEmpty(name) ? "You were" : $"{name}, you were")} {preMin}min into your best run today. Pick it back up."
        : $"Back. {preMin}min of clean focus before that drift. Restart it.";

    sessionState.RecordToastShown(ctx.NowUtc);
    return new UserCommunicationToast(Key: "recovery_nudge", Title: "Ari", Message: msg);
}
```

---

**TRIGGER 4: First focus of day**

```csharp
public static UserCommunicationToast? ResolveFirstFocusToast(
    UserAgentLiveContext ctx,
    UserAgentSessionState sessionState,
    double avgStartHour)  // average hour user usually starts focus, 0 if unknown
{
    if (sessionState.FirstFocusMessageSent) return null;
    if (ctx.CurrentFocusDurationSeconds < 120) return null;  // wait 2 min into focus before firing
    if (!sessionState.CanShowToast(ctx.NowUtc)) return null;

    int currentHour = ctx.NowUtc.ToLocalTime().Hour;
    string name = ctx.FirstName ?? string.Empty;
    string timeLabel = ctx.NowUtc.ToLocalTime().ToString("h:mm tt");

    string msg = avgStartHour > 0 && currentHour < (int)avgStartHour
        ? $"Earlier than your usual start of {(int)avgStartHour}:00. Good start."
        : $"First focus block of the day — {timeLabel}. Ari is watching.";

    sessionState.MarkFirstFocusMessageSent();
    sessionState.RecordToastShown(ctx.NowUtc);
    return new UserCommunicationToast(Key: "first_focus", Title: "Ari", Message: msg);
}
```

---

**TRIGGER 5: Weak hour pattern**

```csharp
public static UserCommunicationToast? ResolveWeakHourToast(
    UserAgentLiveContext ctx,
    UserAgentSessionState sessionState)
{
    if (ctx.WeakHour == null) return null;
    if (!sessionState.CanShowToast(ctx.NowUtc)) return null;

    int currentHour = ctx.NowUtc.ToLocalTime().Hour;
    if (currentHour != ctx.WeakHour.Value) return null;
    if (ctx.CurrentFocusDurationSeconds < 300) return null;  // only fire if in active focus

    string msg = $"{ctx.WeakHour}:00 is usually your soft spot. You're still focused. Keep it.";
    sessionState.RecordToastShown(ctx.NowUtc);
    return new UserCommunicationToast(Key: $"weak_hour_{ctx.WeakHour}", Title: "Ari", Message: msg);
}
```

---

**TRIGGER 6: Long session, no break**

```csharp
public static UserCommunicationToast? ResolveLongSessionNoBreakToast(
    UserAgentLiveContext ctx,
    UserAgentSessionState sessionState)
{
    if (ctx.HasHadABreakToday) return null;
    if (ctx.SessionElapsedMinutes < 180) return null;  // 3 hours minimum
    if (!sessionState.CanShowToast(ctx.NowUtc)) return null;

    string name = ctx.FirstName ?? string.Empty;
    int hours = (int)(ctx.SessionElapsedMinutes / 60);
    string msg = string.IsNullOrEmpty(name)
        ? $"{hours}h without a break. Ari recommends a short stop now."
        : $"{name}, {hours}h without a break. Your next focus window will be stronger with one.";

    sessionState.RecordToastShown(ctx.NowUtc);
    return new UserCommunicationToast(Key: "long_session_no_break", Title: "Ari", Message: msg);
}
```

---

**TRIGGER 7: Session wrap (idle 20+ min after active session)**

```csharp
public static UserCommunicationToast? ResolveSessionWrapToast(
    UserAgentLiveContext ctx,
    UserAgentSessionState sessionState)
{
    // Only fire once per session wrap, when going idle after meaningful work
    if (ctx.TodayTrackedMinutes < 30) return null;
    if (!sessionState.CanShowToast(ctx.NowUtc)) return null;

    int focusMin = (int)ctx.TodayFocusMinutes;
    int trackedMin = (int)ctx.TodayTrackedMinutes;
    int focusPct = trackedMin > 0 ? (int)((double)focusMin / trackedMin * 100) : 0;

    string msg = $"Session wrapped. {focusMin}min of focus from {trackedMin}min tracked — {focusPct}%.";
    sessionState.RecordToastShown(ctx.NowUtc);
    return new UserCommunicationToast(Key: "session_wrap", Title: "Ari", Message: msg);
}
```

---

**Priority queue in UserAgentHost:**

When multiple triggers could fire simultaneously, pick in this order:
1. Recovery nudge (after distraction ends) — highest priority
2. Pressure rising
3. Focus milestone
4. Long session no break
5. Weak hour pattern
6. First focus of day
7. Session wrap (lowest — only fires on idle)

The 8-minute suppression (`CanShowToast`) applies across ALL triggers, enforced by `UserAgentSessionState`. Only one message per 8 minutes maximum, regardless of how many triggers are ready.

---

### 2C. Control Center Bubble (ControlCenter)

**File: `Porta.ControlCenter/TodayPageCopyBuilder.cs`**

Add a new method `BuildAriStatusMessage` that returns the bubble text. This replaces the current generic status labels with contextual observations.

The ControlCenter does NOT have access to `user_history` directly. To keep it simple, the local API should expose a lightweight endpoint `GET /v1/session/ari-context` that returns a small subset of historical values cached by the service (refreshed daily, populated from the control plane's `GET /api/agent/user-context` endpoint).

**State machine: Morning → Active → Pressure → Recovery → End of day**

```csharp
public static string BuildAriStatusMessage(
    LocalApiStatusResponse? status,
    LocalApiCurrentSnapshotResponse? snapshot,
    AriContext? context,   // from the new endpoint — firstName, weakHour, strongWindow, avgStartHour
    double todayFocusMin,
    double todayTrackedMin,
    int distractionCount,
    double avgRecoveryMin,
    bool isPressureHigh,
    int contextSwitchesRecent)
{
    // Morning — no focus yet
    if (todayFocusMin < 5)
    {
        if (context?.StrongWindowStart != null)
        {
            int timeLeft = context.StrongWindowStart.Value - DateTime.Now.Hour;
            if (timeLeft > 0 && timeLeft <= 3)
                return $"Your best window — {context.StrongWindowLabel} — starts in {timeLeft}h. Get ready.";
            if (timeLeft <= 0 && DateTime.Now.Hour <= (context.StrongWindowEnd ?? 24))
                return $"Your strongest window is open now — {context.StrongWindowLabel}. No focus yet today.";
        }
        return "No focus yet today. Ari is ready when you are.";
    }

    // Pressure state
    if (isPressureHigh || contextSwitchesRecent >= 3)
    {
        return $"Pressure building — {contextSwitchesRecent} context switches recently. Consider slowing down.";
    }

    // Active session going well
    if (snapshot?.FocusStrength > 0.6)
    {
        string namePrefix = string.IsNullOrWhiteSpace(context?.FirstName)
            ? "Strong start —"
            : $"{context.FirstName}, strong start —";
        return $"{namePrefix} {(int)todayFocusMin}min of focus so far today.";
    }

    // Has had distraction but recovering fast
    if (distractionCount > 0 && avgRecoveryMin < 5)
    {
        return $"{distractionCount} distraction episodes — recovered from each in under {(int)avgRecoveryMin}min. Unusually fast.";
    }

    // End of day (tracked > 3h and current time > 18:00)
    if (todayTrackedMin >= 180 && DateTime.Now.Hour >= 18)
    {
        int focusPct = (int)(todayFocusMin / todayTrackedMin * 100);
        return $"{(int)todayFocusMin}min focused out of {(int)todayTrackedMin}min tracked — {focusPct}%. Digest fires at 23:30.";
    }

    // Default active state
    return $"{(int)todayFocusMin}min of focus today. Ari is watching.";
}
```

---

## What Each User Sees on Day 1, Day 7, Day 30

**Day 1 (first ever digest):**
- Condition J fires: "X min tracked today. Ari has 1 day of your data — the picture sharpens every session."
- Widget: First focus trigger, milestone triggers, recovery nudge all work (no history needed)
- Bubble: Morning / Active / Pressure states all work (no history needed)

**Day 3:**
- Condition A (streak) can fire if 3 days in a row
- Condition E (quality vs quantity split) fires on interesting patterns
- Condition G (break compliance) fires
- Fallback J now says "3 days tracked in a row"

**Day 7:**
- Condition D (pressure pattern) can fire
- Condition H (recovery after bad day) can fire
- Focus trend appears in condition A

**Day 14:**
- All conditions available except C (day-of-week — needs 4+ of same weekday)
- Weak hour detection active
- Strong window detection active

**Day 30:**
- All conditions fully active
- Day-of-week comparisons reliable
- Personal bests meaningful
- Every message is specific to this user's patterns

---

## Files to Change — Complete List

### Windows Agent (`porta-agent-windows-x64`)
| File | Change |
|---|---|
| `Porta.Agent.Service/Fleet/FleetContracts.cs` | Add 6 new optional fields to `DailyDigestReportPayload` |
| `Porta.Agent.Service/Fleet/DailyDigestReporter.cs` | Compute and include new fields in payload |
| `Porta.UserAgent/Input/UserAgentSessionState.cs` | **New file** — session state tracker |
| `Porta.UserAgent/Interventions/UserCommunicationRouter.cs` | Implement 7 toast triggers, replace stub |
| `Porta.UserAgent/UserAgentHost/UserAgentHost.cs` | Wire session state, call triggers in main loop, fetch ari-context from local API |
| `Porta.Agent.LocalApi/LocalApiEndpointMapping.cs` | Add `GET /v1/session/ari-context` endpoint |
| `Porta.Agent.LocalApi/PortaApiContracts.cs` | Add `AriContextResponse` DTO |
| `Porta.Agent.Service/Fleet/ControlPlaneClient.cs` | Add `GetUserContextAsync()` method |
| `Porta.ControlCenter/TodayPageCopyBuilder.cs` | Add `BuildAriStatusMessage()` method |

### Control Plane (`porta-control-plane`)
| File | Change |
|---|---|
| `src/store/dailyStatsStore.ts` | **New file** — CRUD for `daily_stats` table |
| `src/store/userHistoryStore.ts` | **New file** — CRUD for `user_history` table |
| `src/store/messageRotationStore.ts` | **New file** — message dedup store |
| `src/core/historyService.ts` | **New file** — recomputes `user_history` from `daily_stats` |
| `src/core/digestEmailBuilder.ts` | Replace `buildAriObservation()`, update `buildDigestEmail()` signature |
| `src/api/controllers/agentController.ts` | Accept new digest fields; write to `daily_stats`; call `recomputeUserHistory` |
| `src/api/controllers/agentController.ts` | Add `GET /api/agent/user-context` endpoint |
| `src/store/accountStore.ts` | Add `firstName` field to account profile |
| DB migration | Add `daily_stats`, `user_history`, `message_rotation` tables |

---

## What Not to Touch

- `digestEmailBuilder.ts` HTML structure, CSS, sections, subject fallback — only `buildAriObservation()` changes
- `agentController.ts` existing endpoint logic — only additions
- `UserCommunicationRouter.cs` existing system-state toast logic — only add new toast triggers
- `UserAgentHost.cs` existing capture, heartbeat, signal loops — only add session state calls
- All fleet reporter, machine summary, and digest log code — untouched
- The `digest_log` table — new `daily_stats` is separate, does not replace it
