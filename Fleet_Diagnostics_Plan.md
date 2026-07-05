# Fleet Agent Diagnostics — Execution Plan (Plan 1 of 2)
**For Claude Code · Porta Windows Agent + Control Plane + Operations Console**

---

## Why This Exists

The operations console currently shows `USER_AGENT_SESSION_SWITCHED` and `Activity: No` for 6 out of 8 machines — but this error is **frozen from the last event before the failure started**. It tells us nothing about what is failing *right now*. When Aymene's machine shows AWAY for days while he's actively typing, the console cannot tell you if the UserAgent is running in the wrong session, if hooks are blocked, if signals are being rejected, or if the heartbeat file can't be written. All of those look identical.

**This plan adds a diagnostic code that flows from the UserAgent → heartbeat file → machine summary → control plane → operations console**, so you can see the actual current failure reason per machine from the console without touching any user's machine.

**Rule: This plan is purely additive. No existing field, validation logic, type, or behavior changes. Every new field is nullable/optional. Old machine summaries arriving without new fields must work exactly as before.**

---

## What Already Exists (Do Not Duplicate)

The `UserAgentSessionContextSnapshot` record already has these fields that are written to the heartbeat file but NOT surfaced in the machine summary or console:
- `CaptureSelfTestState` — "passing", "failed", etc.
- `CaptureSelfTestErrorCode` — error code when self-test fails
- `HeartbeatWriteFailureCount` — how many consecutive heartbeat write failures

These need to be carried through the pipeline. Plus we add one new field.

---

## New Field: `CaptureFailureCode`

A single nullable string written by the UserAgent into its heartbeat. It represents the **current active failure reason** — not historical. It is cleared (set to null) when the UserAgent recovers. It has these possible values:

| Value | Meaning |
|---|---|
| `null` | No failure. UserAgent is healthy. |
| `"service_session"` | UserAgent started in session 0 or non-interactive context — no hooks possible. |
| `"hooks_unavailable"` | Both keyboard hook and keyboard poller failed to install. |
| `"signals_not_delivering"` | Input signals consistently failing to reach the local API (5+ consecutive failures). |
| `"self_test_failed"` | Capture self-test reached permanent failure state after 2 remediation attempts. |

Plus a service-side field written by the watchdog (not by the UserAgent):

| Value | Meaning |
|---|---|
| `null` | Last launch attempt succeeded or not attempted yet. |
| `"no_interactive_session"` | Watchdog could not find a WTSActive session with a named user. |
| `"token_query_failed:{win32_code}"` | WTSQueryUserToken failed. Includes the Win32 error code. |
| `"process_create_failed:{win32_code}"` | CreateProcessAsUser failed. Includes the Win32 error code. |

---

## Files to Change

### WINDOWS AGENT (Porta.Agent.Common + Porta.UserAgent + Porta.Agent.Service)

---

### File 1: `Porta.Agent.Common/UserAgent/UserAgentSessionContextStore.cs`

**What to add:** One new optional property to `UserAgentSessionContextSnapshot`.

The record is currently:
```csharp
public sealed record UserAgentSessionContextSnapshot(
    int SchemaVersion,
    string CaptureContext,
    int ProcessId,
    int SessionId,
    DateTimeOffset UpdatedAtUtc,
    string? AgentInstanceId = null,
    string? BinaryVersion = null,
    string? StartupSource = null,
    string? LaunchReason = null,
    long? HeartbeatSequence = null,
    int? HeartbeatWriteFailureCount = null,
    bool? DesktopWidgetReady = null,
    string? CaptureSelfTestState = null,
    string? CaptureSelfTestErrorCode = null,
    int? CaptureSelfTestRemediationCount = null);
```

Add ONE new parameter at the end (must have a default of null so existing code that creates this record without the field still compiles):
```csharp
    string? CaptureFailureCode = null);
```

In `ReadCurrent()`, in the `snapshot with { ... }` block, add:
```csharp
CaptureFailureCode = NormalizeIdentifier(snapshot.CaptureFailureCode),
```

In `WriteCurrent()`, in the `normalized = snapshot with { ... }` block, add:
```csharp
CaptureFailureCode = NormalizeIdentifier(snapshot.CaptureFailureCode),
```

**Do not change `CurrentSchemaVersion`.** Adding a nullable field to the JSON is backward-compatible — old heartbeat files that don't have this field will deserialize with `null`, which is correct.

---

### File 2: `Porta.UserAgent/UserAgentHost/UserAgentHost.cs`

**What to add:** Write `CaptureFailureCode` into the heartbeat at each failure point. Clear it when healthy.

Add a private field to track the current failure code:
```csharp
private string? _captureFailureCode;
```

**Point 1 — ServiceSession detection** (already in `ExecuteAsync`, line ~115):

After the existing log for `ServiceSession`, set the failure code:
```csharp
if (_captureContext == UserAgentCaptureContexts.ServiceSession)
{
    _logger.LogWarning("...");
    UserAgentFileLog.Info("...");
    _captureFailureCode = "service_session";  // ADD THIS LINE
}
```

**Point 2 — Hook installation failure.** Find where `_hooksInstalled` is set. After the block that attempts both keyboard hook and keyboard poller, if both failed:
```csharp
if (!_hooksInstalled)
{
    _captureFailureCode = "hooks_unavailable";
    UserAgentFileLog.Info($"capture_hooks_unavailable pid={Environment.ProcessId} session={_sessionId}");
}
else if (_captureFailureCode == "hooks_unavailable")
{
    _captureFailureCode = null;  // Clear if hooks recovered
}
```

**Point 3 — Signal delivery failure.** The UserAgent already tracks consecutive send failures internally. Find where `SendInputSignalsAsync` result is checked. After 5 consecutive failures, set:
```csharp
_captureFailureCode = "signals_not_delivering";
```
When a signal is successfully delivered (ack.Success == true), clear it:
```csharp
if (_captureFailureCode == "signals_not_delivering")
{
    _captureFailureCode = null;
}
```

**Point 4 — Self-test permanent failure.** Find where `_captureSelfTest` state is read. When `CaptureSelfTestStates.Failed` is detected:
```csharp
_captureFailureCode = "self_test_failed";
```

**Point 5 — Write the code into every heartbeat.** Find the method that builds and writes the `UserAgentSessionContextSnapshot`. Add `CaptureFailureCode = _captureFailureCode` to the snapshot being written. This is the ONLY change to the heartbeat write call — everything else stays identical.

**Important:** When the UserAgent starts healthy in UserSession mode with hooks installed and signals delivering, `_captureFailureCode` is null. Only set it on actual failure. Never set it to an empty string — always use null to represent "healthy".

---

### File 3: `Porta.Agent.Service/Fleet/FleetContracts.cs`

**What to add:** Two new optional fields to `MachineSummaryReportPayload`.

Find the record and add at the end (must have null defaults):
```csharp
string? UserAgentCaptureFailureCode = null,
string? WatchdogLaunchFailureCode = null,
// Also add the two existing heartbeat fields that aren't currently surfaced:
string? UserAgentSelfTestState = null,
string? UserAgentSelfTestErrorCode = null
```

**Safety:** These must be optional with null defaults. Any existing code that creates `MachineSummaryReportPayload` without these fields will still compile unchanged.

---

### File 4: `Porta.Agent.Service/Fleet/MachineSummaryMapper.cs`

**What to add:** Read the new fields from `AgentServiceStatusSnapshot` and add them to the payload.

The `AgentServiceStatusSnapshot` is populated by the controller, which reads the heartbeat. You need to verify that `AgentServiceStatusSnapshot` exposes the new `CaptureFailureCode` from the heartbeat. If it doesn't yet, add it to that type (see File 5 below first).

In the `Map(...)` method, add these variables alongside the existing ones:
```csharp
string? captureFailureCode = NullIfWhiteSpace(status.UserAgentCaptureFailureCode);
string? watchdogLaunchFailureCode = NullIfWhiteSpace(status.WatchdogLaunchFailureCode);
string? selfTestState = NullIfWhiteSpace(status.UserAgentSelfTestState);
string? selfTestErrorCode = NullIfWhiteSpace(status.UserAgentSelfTestErrorCode);
```

And pass them into the `MachineSummaryReportPayload(...)` constructor at the end of the method. No other logic changes.

---

### File 5: `Porta.Agent.Core/AgentCoreController.cs` (or wherever `AgentServiceStatusSnapshot` is built)

**What to add:** The controller builds `AgentServiceStatusSnapshot` from the session context snapshot. Verify it already reads `CaptureSelfTestState` and `CaptureSelfTestErrorCode` from the heartbeat — if not, add those reads. Add the new `CaptureFailureCode` read from the heartbeat alongside them.

Also add `WatchdogLaunchFailureCode` to `AgentServiceStatusSnapshot`. This is set by the watchdog (see File 6) and stored in the controller state so it appears in every machine summary until the next successful launch clears it.

---

### File 6: `Porta.Agent.Service/CurrentSessionUserAgentWatchdog.cs`

**What to add:** When `TryLaunchInSession` fails, record the failure code into the controller.

In `CurrentSessionUserAgentWatchdogCoordinator.EnsureHealthy()`, after the call to `_runtime.TryLaunchInSession`:
```csharp
if (!_runtime.TryLaunchInSession(currentSessionId, decision.Reason, _logger))
{
    _logger.LogError("Failed to launch Porta.UserAgent...");
    // ADD: update the controller with the failure reason
    // The failure reason comes from what TryLaunchInSession reports
    // You may need to change TryLaunchInSession to return a failure code string
    // instead of just bool, so callers know WHY it failed
}
```

The simplest approach: change `TryLaunchInSession` to return a `string?` failure code (null = success, non-null = failure reason). Then the coordinator passes this to the controller via a new method `SetWatchdogLaunchFailureCode(string? code)`. When a launch succeeds, call `SetWatchdogLaunchFailureCode(null)` to clear it.

**Do not change the existing logging.** Only add the controller update call.

---

### CONTROL PLANE (porta-control-plane)

---

### File 7: `src/api/controllers/agentController.ts`

**What to add:** Accept the four new fields in `normalizeMachineSummaryReport`.

Find the `normalizeMachineSummaryReport` function. At the end of the returned object, add:
```typescript
userAgentCaptureFailureCode: isOptionalString(row.userAgentCaptureFailureCode)
    ? (row.userAgentCaptureFailureCode?.trim() || null)
    : null,
watchdogLaunchFailureCode: isOptionalString(row.watchdogLaunchFailureCode)
    ? (row.watchdogLaunchFailureCode?.trim() || null)
    : null,
userAgentSelfTestState: isOptionalString(row.userAgentSelfTestState)
    ? (row.userAgentSelfTestState?.trim() || null)
    : null,
userAgentSelfTestErrorCode: isOptionalString(row.userAgentSelfTestErrorCode)
    ? (row.userAgentSelfTestErrorCode?.trim() || null)
    : null,
```

**Do not touch any existing field validation.** Do not change `normalizeMachineSummaryReport`'s structure — only add at the end of the return object.

---

### File 8: `src/store/machineSummaryStore.ts`

**What to add:** Store and return the new fields alongside the existing ones.

Find where machine summaries are stored (likely `upsertMachineSummary` and `listMachineSummaries` / `getMachineSummary`). Add the four new fields to the stored object with null defaults. If using Postgres with typed columns, add a migration that adds four nullable text columns with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. If using JSONB storage, no migration needed.

---

### OPERATIONS CONSOLE (porta-operations-console)

---

### File 9: Machine detail table component

**What to add:** A new "Capture Issue" column in the machine detail table.

The machine detail table currently shows: Machine, User, Device Status, Last Seen, Agent, Activity, 7d Uptime, Error.

Add a new column **"Capture Issue"** between "Activity" and "7d Uptime". This column shows:
- **Green "—"** when `userAgentCaptureFailureCode` and `watchdogLaunchFailureCode` are both null
- **Red badge** with the failure code when either is non-null

Priority: if `watchdogLaunchFailureCode` is set, show that. Otherwise show `userAgentCaptureFailureCode`. If both are null, show "—".

Human-readable labels for the console:

| Code | Display |
|---|---|
| `"service_session"` | Wrong session (no hooks) |
| `"hooks_unavailable"` | Hooks blocked |
| `"signals_not_delivering"` | Signals not reaching API |
| `"self_test_failed"` | Capture self-test failed |
| `"no_interactive_session"` | No desktop session found |
| `"token_query_failed:..."` | Session token error |
| `"process_create_failed:..."` | Process launch failed |

Also add `userAgentSelfTestState` as a tooltip on the existing "Error" column, so hovering it shows the self-test state alongside the existing error code.

**Do not remove or modify the existing "Error" column** (`lastError`). It stays exactly as-is. The new column is additive.

---

## What Not to Touch

- Do not change `CurrentSchemaVersion` in `UserAgentSessionContextStore`
- Do not modify any existing validation in `normalizeMachineSummaryReport`
- Do not change the existing `captureFailureReason` logic in `MachineSummaryMapper`
- Do not change the existing `lastError` field or how it's computed
- Do not change `UserAgentCaptureContexts` constants
- Do not change `HasHealthyHeartbeat` in `CurrentSessionUserAgentRecoveryEvaluator`
- Do not change anything in the digest reporter, fleet reporter, or identity flow

---

## Verification

After deployment:
1. Open the operations console machine detail table
2. For each machine, the new "Capture Issue" column should show a specific failure code instead of the generic `USER_AGENT_SESSION_SWITCHED`
3. For your machine (DESKTOP-0MMJH0I), it should show "—" (no capture issue)
4. For EBBY, it should show "service_session" (running in session 0 with old version)
5. For AYMENE and others, you'll see the actual current failure reason for the first time

This tells you exactly what to fix for each machine in Plan 2.
