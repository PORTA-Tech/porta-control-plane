# DailyDigestReporter — Fix Execution Plan
**For Claude Code · Porta Windows Agent**

---

## 1. System Context

Porta is a Windows productivity agent. Users install it on their machines. It runs two main processes:

- **Porta.Agent.Service** — a Windows Service (service name: AriAgent) that runs persistently in the background. It hosts the brain loop, a local Kestrel HTTP API on localhost, the fleet reporter, and the daily digest reporter.
- **Porta.UserAgent** — a user-session process that captures keyboard/mouse signals and delivers break overlays. Managed by the service watchdog.

The fleet reporter sends machine summaries to a control plane hosted on Render every 10 seconds. The control plane is a Node.js/Express app that stores data and calls Resend to send emails.

Every night at **23:30 Dubai time (19:30 UTC)**, a daily productivity digest email is supposed to be sent to the user's registered email address via the control plane.

---

## 2. Confirmed Root Cause

**What DailyDigestReporter currently does (wrong):**

The class is a `BackgroundService` registered inside `Porta.Agent.Service`. It polls every 30 seconds. It already has `IAgentCoreController` injected — the same controller that manages all brain state and exposes a `GetTimeline()` method that returns the full day's tracking data directly from memory/SQLite.

Despite having direct access to the controller, to get timeline data the reporter creates a brand new `LocalApiClient` and makes an HTTP request to **itself** at `localhost:17893` with a **3-second timeout**. Every failure mode is silently caught: if `GetTimelineAsync()` returns null for any reason, the reporter just returns without sending — no log, no error, nothing. The next poll 30 seconds later tries again.

**Why this silently fails:**

The 3-second timeout is very tight for a loopback call that queries SQLite for a full day of 60-second buckets. Any brief SQLite contention, any auth token read delay, or any transient issue causes a timeout exception that is swallowed and returns null. The digest never sends that poll cycle.

**What is confirmed working correctly:**

- The AriAgent Windows service IS installed and running
- The `PORTA_BACKEND_URL` env var IS configured and visible to the service
- The identity IS linked to an account
- The control plane on Render IS reachable — machine summaries reach it every 10 seconds
- The DPAPI token uses `DataProtectionScope.LocalMachine` — SYSTEM can read it fine

The only broken path is the HTTP loopback call in the digest reporter.

---

## 3. The Fix

**Change only one file:** `Porta.Agent.Service/Fleet/DailyDigestReporter.cs`

Replace the `LocalApiClient` HTTP call with a direct call to `_controller.GetTimeline()`. `Porta.Agent.Service` already references both `Porta.Agent.Core` and `Porta.Agent.LocalApi`, so `SnapshotMapper` and `EventMapper` are available without adding any new dependencies. Build the `LocalApiTimelineResponse` in-process from the controller result, then pass it to the existing `AggregateTimeline()` method unchanged.

Everything else stays exactly as-is: the HTTP `/v1/timeline` endpoint in `LocalApiEndpointMapping`, the `AggregateTimeline` logic, the `PostDailyDigestAsync` call, the `_lastSentDate` tracking, and all other files.

---

## 4. Step-by-Step Instructions

### Step 1 — Find the block to replace

Open `Porta.Agent.Service/Fleet/DailyDigestReporter.cs` and locate the method `TrySendDigestAsync`. Find this block near the top of the method:

```csharp
LocalApiClient localClient = new();
LocalApiTimelineResponse? timeline = await localClient.GetTimelineAsync(
    startOfDayUtc, nowUtc, bucketSeconds: 60, token).ConfigureAwait(false);

if (timeline == null)
{
    return;
}
```

### Step 2 — Replace it with a direct controller call

Delete the block above entirely and replace it with:

```csharp
AgentTimelineData timelineData = _controller.GetTimeline(startOfDayUtc, nowUtc, 60);
LocalApiTimelineResponse timeline = new(
    timelineData.FromUtc,
    timelineData.ToUtc,
    timelineData.BucketSeconds,
    timelineData.Snapshots
        .Select(static s => SnapshotMapper.Map(s))
        .ToList(),
    timelineData.Interventions
        .Select(EventMapper.Map)
        .ToList());
```

### Step 3 — Update using statements

Add at the top of the file:

```csharp
using Porta.Agent.LocalApi.Mappers;
```

Remove from the top of the file (only if `LocalApiClient` is no longer referenced anywhere else in the file):

```csharp
using Porta.Agent.LocalApi;
```

### Step 4 — Verify SnapshotMapper.Map signature

Open `Porta.Agent.LocalApi/Mappers/SnapshotMapper.cs` and confirm the signature of the `Map` method. It should accept an `AgentBrainSnapshot` as its first argument and return `LocalApiCurrentSnapshotResponse`. If it has optional additional parameters (`latestState`, `status`), omit them — the defaults are fine for the digest aggregation.

### Step 5 — Verify EventMapper.Map signature

Open `Porta.Agent.LocalApi/Mappers/EventMapper.cs` and confirm the `Map` method accepts an `AgentControlEvent`. If it is not directly compatible with `.Select(EventMapper.Map)`, use a lambda instead:

```csharp
.Select(e => EventMapper.Map(e))
```

### Step 6 — Confirm nothing else in TrySendDigestAsync changed

The rest of the method must remain exactly as it was:
- The `AggregateTimeline(timeline)` call
- The `MinimumTrackedSecondsToSend` check
- The `_controller.GetCurrentDistractionSummary()` call
- The `PostDailyDigestAsync` call
- The `_lastSentDate = todayUtc` assignment

Only the `LocalApiClient` block at the top of the method changes.

### Step 7 — Build

Build `Porta.Agent.Service`. Confirm zero new errors or warnings. The diff should show changes only in `DailyDigestReporter.cs`.

---

## 5. Files to NOT Touch

These files must not be modified:

- `Porta.Agent.LocalApi/LocalApiClient.cs`
- `Porta.Agent.LocalApi/LocalApiEndpointMapping.cs`
- `Porta.Agent.LocalApi/LocalApiRuntimeSettingsStore.cs`
- `Porta.Agent.Core/Security/Secrets.cs`
- `Porta.Agent.Core/IAgentCoreController.cs`
- `Porta.Agent.Core/AgentLocalStoreModels.cs`
- `Porta.Agent.Core/AgentCoreController.cs`
- `porta-control-plane/src/core/emailService.ts`
- `porta-control-plane/src/api/controllers/agentController.ts`

Do not add new types, new interface methods, new NuGet packages, or new projects. Do not change any Windows service configuration, environment variables, or DPAPI settings.

---

## 6. Verification

After deploying the updated service binary:

- **Real test:** At 23:30 Dubai time (19:30 UTC), if the machine has been active for at least 1 hour that day, a digest email should arrive in the registered user's inbox without any manual action.
- **Control plane log:** The `GET /v1/digest/log` endpoint on the control plane returns digest log entries from the database. A `fired: true` entry for today's date confirms the email was sent.

**Quick smoke test (optional):** Temporarily set `DigestHourUtc` and `DigestMinuteUtc` in `DailyDigestReporter.cs` to a time 2–3 minutes in the future, set `MinimumTrackedSecondsToSend` to `0`, deploy, wait for the email, then restore the original values and redeploy.
