# Fleet Agent Failures — Fix Execution Plan (Plan 2 of 2)
**For Claude Code · Porta Windows Agent**

---

## Context — Read This First

**Do Plan 1 (Fleet_Diagnostics_Plan.md) before this plan.**

This plan fixes the behavioral problems causing the UserAgent to silently fail on user machines. Six out of eight machines in the fleet show `Activity: No` even when users are actively typing. The root cause is that after Windows session events (screen lock, RDP, fast user switch), the UserAgent fails to recover correctly, and the failure is completely invisible.

**The full failure chain identified from the code:**

There are six distinct failure modes. They are independent — a machine can be hitting one, several, or all of them. Plan 1 will tell you which mode each machine is in. Plan 2 fixes all of them.

**CRITICAL: These fixes change behavior, not data structures. Every change must be contained and reversible. Do not change the public API surface of any class, do not change heartbeat schema version, do not change the machine summary DTO. Only change internal logic within the specific methods described.**

---

## Failure Mode 1: UserAgent Starts in ServiceSession Mode

**What happens:** The UserAgent process is launched by the watchdog via `CreateProcessAsUser` with `lpDesktop = "winsta0\\default"`. When it starts, line ~100 of `UserAgentHost.cs` checks:

```csharp
_captureContext = IsInteractiveUserSession(_sessionId)
    ? UserAgentCaptureContexts.UserSession
    : UserAgentCaptureContexts.ServiceSession;
```

```csharp
private static bool IsInteractiveUserSession(int sessionId) =>
    Environment.UserInteractive && sessionId > 0;
```

If `Environment.UserInteractive` is false OR `sessionId == 0`, the UserAgent enters ServiceSession mode. In ServiceSession mode it publishes heartbeats but **installs zero hooks and captures zero activity**. The watchdog detects `CaptureContext != "UserSession"` in the heartbeat, kills the UserAgent, relaunches it — but if the underlying environment condition persists, the next launch also hits ServiceSession mode. This becomes an infinite restart loop with zero capture on every cycle.

**The EBBY machine shows `User: unknown` in the console** — this is because the session ID being reported is 0, which means `WTSQuerySessionInformation(sessionId=0)` returns no username (session 0 is the Windows services session with no interactive user).

**Fix 1A — Exit immediately when in ServiceSession mode:**

Currently the UserAgent continues running in ServiceSession mode. It should instead exit after writing the failure code to the heartbeat. This:
- Stops the wasteful restart loop from running for 30 seconds per cycle
- Forces the watchdog to surface the failure via the new `WatchdogLaunchFailureCode` (from Plan 1)
- Makes the failure state unambiguous: no running UserAgent = launch is failing

In `UserAgentHost.ExecuteAsync()`, find the ServiceSession detection block. After writing the `CaptureFailureCode = "service_session"` to the heartbeat (from Plan 1), add:

```csharp
if (_captureContext == UserAgentCaptureContexts.ServiceSession)
{
    // Write failure code to heartbeat first so the watchdog can read it
    PublishSessionContext();  // call the heartbeat write method once
    
    UserAgentFileLog.Info(
        $"user_agent_exiting_service_session pid={Environment.ProcessId} session={_sessionId}");
    return;  // Exit ExecuteAsync — causes the host to shut down cleanly
}
```

**Why this is safe:** The watchdog already handles `missing_process` — it will detect the UserAgent exited and relaunch. The difference is the relaunch is faster (immediate vs 30-second stale heartbeat timeout) and the reason is now logged in the new diagnostic code.

**Fix 1B — Improve WTSQueryUserToken failure logging in the watchdog:**

In `WindowsCurrentSessionUserAgentRuntime.TryLaunchInSession()`, the existing code:
```csharp
if (!WTSQueryUserToken(sessionId, out IntPtr userToken) || userToken == IntPtr.Zero)
{
    logger.LogError(
        "WTSQueryUserToken failed for session {SessionId}. Error={ErrorCode}",
        sessionId,
        Marshal.GetLastWin32Error());
    return false;
}
```

Change the return type of `TryLaunchInSession` from `bool` to `string?` (null = success, non-null = failure code string). Return `$"token_query_failed:{Marshal.GetLastWin32Error()}"` here. Similarly for `CreateProcessAsUser` failure: return `$"process_create_failed:{Marshal.GetLastWin32Error()}"`. This failure code flows to the machine summary via the changes in Plan 1.

Update `ICurrentSessionUserAgentRuntime.TryLaunchInSession` signature accordingly. Update `CurrentSessionUserAgentWatchdogCoordinator.EnsureHealthy()` to use the new return value and pass it to the controller.

---

## Failure Mode 2: Hook Installation Silently Fails

**What happens:** The UserAgent calls `_keyboardHook.Install()` and if it returns false, falls back to `_keyboardPoller.Install()`. If both fail, `_hooksInstalled` stays false. The UserAgent continues running, heartbeat writes succeed, the watchdog thinks everything is healthy — but no keyboard or mouse events are ever captured. `KeyboardSignalActive` and `MouseSignalActive` stay false forever.

This is most common when security software (endpoint detection/response tools like CrowdStrike, Carbon Black, Defender for Endpoint) intercepts or blocks `WH_KEYBOARD_LL` and `WH_MOUSE_LL` global hooks. The hook appears to install (no exception) but the callback never fires.

The `CaptureSelfTest` catches this — it sends synthetic input and waits for the hook to fire. But the self-test takes time and only resets hooks up to 2 times before marking itself as permanently failed. Even then, the failure isn't visible in the console.

**Fix 2A — Immediate hook failure detection:**

Find the block in `UserAgentHost` where `_hooksInstalled` is determined. After the block, add:

```csharp
if (!_hooksInstalled)
{
    _captureFailureCode = "hooks_unavailable";
    UserAgentFileLog.Info(
        $"capture_hooks_failed pid={Environment.ProcessId} session={_sessionId}");
    // Do NOT exit here — the self-test mechanism will try to remediate
    // and the watchdog will eventually restart if remediation fails
}
```

**Fix 2B — Self-test permanent failure causes UserAgent exit:**

When the CaptureSelfTest reaches `CaptureSelfTestStates.Failed` (after 2 remediation attempts), the UserAgent should exit so the watchdog can relaunch it. Find where self-test state is read in the main loop. When state == Failed AND it has been in that state for more than 60 seconds (to avoid premature exit during the remediation window):

```csharp
if (selfTestState == CaptureSelfTestStates.Failed && selfTestFailedForSeconds > 60)
{
    UserAgentFileLog.Info(
        $"user_agent_exiting_self_test_failed pid={Environment.ProcessId} session={_sessionId}");
    return;  // Exit — watchdog will relaunch
}
```

**Why 60 seconds:** The remediation process needs time to reset hooks and retry. Exiting immediately would interfere with the existing remediation logic.

**Why exit instead of staying:** If hooks are permanently failed, the UserAgent is running but useless. Staying running prevents the watchdog from detecting the problem and relaunching. Exiting forces a fresh start.

---

## Failure Mode 3: Input Signals Not Reaching the Local API

**What happens:** The UserAgent captures keyboard/mouse events via hooks, aggregates them into signal packets, and sends them to `POST /v1/input/signals` on the local API. If this call consistently fails (auth token mismatch, local API down, rate limit), `Requeue()` keeps the data in memory but `RecordPublishAccepted()` is never called. The self-test eventually detects `input_publish_not_confirmed` and resets hooks — but the underlying delivery failure persists.

**Fix 3 — Track consecutive signal delivery failures and exit after threshold:**

In `UserAgentHost`, add a counter for consecutive signal delivery failures:
```csharp
private int _consecutiveSignalDeliveryFailures;
private const int MaxConsecutiveSignalFailures = 10;
```

In the signal flush logic, when `SendInputSignalsAsync` returns a non-success result:
```csharp
_consecutiveSignalDeliveryFailures++;
if (_consecutiveSignalDeliveryFailures >= MaxConsecutiveSignalFailures)
{
    _captureFailureCode = "signals_not_delivering";
    UserAgentFileLog.Info(
        $"signals_not_delivering_exit pid={Environment.ProcessId} consecutive_failures={_consecutiveSignalDeliveryFailures}");
    return;  // Exit — watchdog will relaunch with a fresh client
}
```

When a signal delivery succeeds:
```csharp
_consecutiveSignalDeliveryFailures = 0;
if (_captureFailureCode == "signals_not_delivering")
{
    _captureFailureCode = null;
}
```

**Why 10 failures before exit:** A single flush cycle is every 60 seconds. 10 failures = 10 minutes of persistent failure. This avoids exiting on transient issues while catching real failures quickly enough to matter.

**Why exit:** When `SendInputSignalsAsync` fails, it's usually because `_localApiClient.IsConfigured` is false (settings not loaded yet) or the auth token has an issue. Creating a fresh `LocalApiClient` on restart clears the cached token. This is the cleanest recovery path.

**Important:** The existing requeue mechanism (`_signalAggregator.Requeue(snapshot)`) must still be called before the exit. Do not skip the requeue. The in-memory signals are lost when the process exits — this is acceptable because the watchdog will relaunch within seconds and capture will resume.

---

## Failure Mode 4: Heartbeat Write Failure Loop

**What happens:** The heartbeat file is `C:\ProgramData\PortaAgent\user-agent-session-context.v1.json`. Multiple UserAgent processes try to write this file simultaneously (during the restart cycles), and the `File.Replace` / `File.Move` calls fail with `UnauthorizedAccessException` or `IOException`. The UserAgent logs `heartbeat_write_failed` and continues running. The heartbeat goes stale. The watchdog detects stale and relaunches another UserAgent. The new UserAgent also can't write. Loop continues indefinitely.

The current code in `WriteCurrent()` retries up to 4 times with short delays. This is good for transient failures. But persistent failures are not handled.

**Fix 4 — Exit after persistent heartbeat write failure:**

The `_heartbeatWriteFailureCount` field already exists in `UserAgentHost`. Find where it is incremented on heartbeat write failure. After incrementing, add:

```csharp
_heartbeatWriteFailureCount++;
UserAgentFileLog.Info(
    $"heartbeat_write_failed pid={Environment.ProcessId} failure_count={_heartbeatWriteFailureCount} path={...}");

if (_heartbeatWriteFailureCount >= 5)
{
    UserAgentFileLog.Info(
        $"user_agent_exiting_heartbeat_write_failed pid={Environment.ProcessId} consecutive_failures={_heartbeatWriteFailureCount}");
    return;  // Exit — watchdog will detect missing process and relaunch
}
```

Reset the counter on successful write:
```csharp
_heartbeatWriteFailureCount = 0;
```

**Important:** The `_heartbeatWriteFailureCount` field already exists. Do NOT add a new field. Use what's already there.

**Why 5 failures:** Heartbeat writes happen every 5 seconds. 5 failures = 25 seconds of persistent write failure. This catches real permission/locking issues while not exiting on the normal transient conflicts between tmp file promotion.

**Why not more retries in WriteCurrent instead:** `WriteCurrent` already does 4 retries. Adding more delays inside it would block the main loop. Exiting and letting the watchdog handle it is cleaner.

---

## Failure Mode 5: Version Mismatch Restart Loop (Edge Case)

**What happens:** `IsVersionMismatch` in `CurrentSessionUserAgentRecoveryEvaluator` returns true if the running UserAgent's binary version doesn't match the expected binary version read from the binary on disk. If there's a partial update (the service was updated but the UserAgent binary was not replaced correctly), this causes an infinite restart loop.

**Fix 5 — Add version mismatch cap:**

In `CurrentSessionUserAgentWatchdogCoordinator`, track how many times a version-mismatch restart has been attempted:

```csharp
private int _versionMismatchRestartCount;
private const int MaxVersionMismatchRestarts = 3;
```

If `decision.Reason == "version_mismatch"` and `_versionMismatchRestartCount >= MaxVersionMismatchRestarts`, switch to `WaitForHeartbeat` action instead (don't restart). Log a warning that version mismatch is persistent and needs manual intervention.

Reset the counter when a healthy heartbeat is seen.

**Why this is safe:** 3 restarts is enough to recover from a normal update. If after 3 restarts the version still mismatches, something is wrong with the deployment and repeated restarts won't fix it — they'll just burn CPU and make the logs noisy.

---

## Failure Mode 6: Session Switch Leaves UserAgent in Broken State (Existing Watchdog Handles This)

**What happens:** A session switch event (screen lock, RDP session, fast user switch) fires. The OS may kill the UserAgent process. The watchdog detects `missing_process` or `stale_heartbeat` and relaunches.

**This is already handled correctly by the watchdog.** The watchdog polls every 5 seconds. If the UserAgent was killed by a session switch, it relaunches within 5 seconds. This is confirmed working on your machine (DESKTOP-0MMJH0I) where you see repeated `source=service-watchdog launch_reason=stale_heartbeat` restarts in the user-agent.log.

**The problem is NOT the session switch itself — it's what happens AFTER relaunch (Failure Modes 1–4 above).** The session switch is the trigger that exposes those bugs. Fixing Modes 1–4 will fix the post-session-switch recovery on all machines.

**No code change needed for this mode specifically.**

---

## What Not to Touch

**Do not change:**
- `CurrentSessionUserAgentRecoveryEvaluator` logic (except the version mismatch cap in Fix 5)
- `HasHealthyHeartbeat` conditions
- `TryGetInteractiveSessionId` logic
- `UserAgentCaptureContexts` constants
- `UserAgentSessionContextStore.CurrentSchemaVersion`
- The heartbeat write retry logic inside `WriteCurrent()` (it is correct as-is)
- The `CaptureSelfTest` remediation logic (it is correct — we only add the exit after permanent failure)
- `LocalApiClient` timeout values
- Any control plane code
- Any operations console code (those are in Plan 1)

---

## Order of Changes

Implement in this order to minimize risk:

1. **Fix 1B first** (change `TryLaunchInSession` return type). This is a pure refactor — same behavior, better information. It unblocks Plan 1's diagnostic flow.
2. **Fix 1A** (ServiceSession exit). Small, contained, dramatically speeds up failure detection.
3. **Fix 4** (heartbeat write failure exit). Small, uses existing counter.
4. **Fix 3** (signal delivery failure exit). Medium complexity, very impactful.
5. **Fix 2A** (hook failure code). Small, purely additive.
6. **Fix 2B** (self-test failure exit). Needs the 60-second threshold to be implemented carefully.
7. **Fix 5** (version mismatch cap). Edge case, do last.

---

## How to Verify Without Touching User Machines

After deploying Plan 1 and Plan 2 together:

1. **Console shows specific failure codes** instead of generic `USER_AGENT_SESSION_SWITCHED`
2. **Recovery is faster** — machines that were stuck in infinite restart loops now exit and relaunch in seconds instead of waiting 30 seconds per cycle for stale heartbeat detection
3. **Your machine (DESKTOP-0MMJH0I) should behave the same or better** — it was already working, and these fixes only change behavior when failures occur
4. **EBBY** needs the binary upgraded (Plan 1 will confirm session 0). No code fix helps if the binary itself is old
5. **AYMENE and others** — after deploy, the console shows the specific failure code. If it shows `"service_session"`, the launch mechanism is broken on that machine's Windows configuration. If it shows `"hooks_unavailable"`, security software is blocking hooks. Different failure → different support action. Now you can distinguish them.
