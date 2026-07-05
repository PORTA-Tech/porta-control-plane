# Growth Funnel & Operations Console Accuracy — Fix Plan

**Goal:** make every number in the operations console and growth dashboard trustworthy, and make growth measure the full real funnel (installs → registrations → activation → retention), not just registered accounts.

**No agent changes required.** 1.2.82 already ships everything the agent needs (real activity timestamps, capture loop hardening, log-tail telemetry). Everything below is control plane + operations console.

---

## Verified facts driving this plan (from production, 2026-06-10)

| Fact | Evidence |
|---|---|
| 10 machines exist, growth shows 4 users | Growth counts registered accounts only; 7 of 10 machines have `accountId = null` |
| 2 brand-new installs today are anonymous | JOYCERUSSE (alexismc), ZACHHUG (stephpie) — installed 1.2.81, never signed up |
| Activity data was fabricated until 1.2.82 | Old agents set `lastActivityUtc = windowEnd` even with zero captured input |
| Active-day / activation gate trusted the fabricated field | `agentController.ts` line ~381: `payload.activityDetected \|\| Boolean(payload.lastActivityUtc)` |
| Machines dead for weeks still show "active" chip | DORREYES last report May 25, DANISH May 19 — `deviceStatus` is the *device-link* state, not liveness |
| Console renders metrics derived from zero data | "14%" focus quality shown for machines that never delivered one input packet |
| Fleet runs 5 different agent versions | 1.0.38 → 1.2.82, no outdated-version indicator anywhere |

---

## Part A — Growth measures the real funnel

### A1. New growth event: `machine_installed`
- **Where:** `src/api/controllers/agentController.ts` (machine-summary handler) and `src/api/controllers/deviceIdentityController.ts` (device registration).
- **What:** on first contact from a machine, append a growth event with `eventKey = machine_installed:{machineId}` (the unique eventKey makes it idempotent — same pattern as `account_activated:{accountId}`). Store `machineId`, `agentVersion`, `accountId` (null if unlinked), `occurredAtUtc = devices.first_seen_at`.
- **Why eventKey idempotency:** machines report every ~30s; the unique key means only the first report inserts.

### A2. Backfill script for existing machines
- **Where:** new `scripts/backfill-install-events.mjs` (same pattern as `backfill-growth-facts.mjs`).
- **What:** for every row in `devices`, insert `machine_installed` event from `first_seen_at` if not present. For machines in `machine_summaries` with no device row (very old agents), use earliest `machine_uptime_samples.sampled_at_utc`.
- Run once against production after deploy.

### A3. Growth summary gains funnel fields
- **Where:** `src/core/growthReadService.ts` (`GrowthSummary` assembly), `src/api/controllers/growthController.ts`.
- **New fields** (additive, same `as`-cast pattern used for machine-summary extensions; vendored `@porta/api-contracts` does not need rebuilding):
  - `total_installs` — count of `machine_installed` events in window + before
  - `reporting_machines` — machines with a summary in the last 48h
  - `linked_machines` / `unlinked_machines`
  - `install_to_registration_rate_pct` — registered accounts with ≥1 device ÷ total installs
- **Existing fields unchanged** — registered/activated/retention keep their definitions so historical comparisons stay valid.

### A4. Installs time series
- **Where:** `src/core/growthReadService.ts` series builder.
- **What:** new series metric `installs` (per day/week/month) from `machine_installed` events — plots adoption even when nobody registers.

### A5. Console growth page funnel (operations-console repo)
- Funnel bar: **Installs → Reporting → Registered → Activated → Retained(D7)** with conversion % between each stage.
- Annotate the chart: "activity data before 2026-06-10 may be inflated (agent bug, fixed in 1.2.82)".
- **Note:** requires the `porta-operations-console` repo to be connected when implementing.

---

## Part B — Activation & retention integrity

### B1. Stop trusting fabricated activity
- **Where:** `src/api/controllers/agentController.ts` machine-summary handler.
- **Current gate:** `payload.activityDetected || Boolean(payload.lastActivityUtc)` — old agents always pass it because `lastActivityUtc` was fabricated.
- **New gate:**
  - agentVersion ≥ 1.2.82 → `activityDetected === true || (lastAcceptedInputAgeSeconds != null && lastAcceptedInputAgeSeconds < 3600)` (trustworthy after the fix)
  - agentVersion < 1.2.82 → `activityDetected === true` only (the one field old agents never fabricate)
- **Effect:** linked-but-idle machines stop generating fake "active days"; retention/churn become real.

### B2. Historical contamination — accept, don't rewrite
- Pre-June-10 `account_active_day` rows can't be reliably separated into real vs fabricated. Deleting guesses would corrupt more than it fixes.
- **Decision:** keep history, annotate the growth UI (A5), trust data from 1.2.82 rollout onward.

---

## Part C — Console truthfulness (machine list & detail)

### C1. Server-derived presence state
- **Where:** `src/core/fleetReadService.ts` (`joinSummaries`).
- **New derived fields on each summary row:** `presence: 'online' | 'recent' | 'offline'` (reportedAt < 2 min / < 60 min / older) and `offlineSinceUtc`.
- **Console:** presence becomes the primary status chip. `deviceStatus` ("active") is renamed to a **Link** column — it means "device credential not revoked", never "machine alive". DORREYES must show **OFFLINE since May 25**, not a green chip.

### C2. Never render metrics derived from zero data
- **Where:** `fleetReadService.ts` adds `hasInputData: boolean` (true iff `lastAcceptedInputAgeSeconds != null` on ≥1.2.82, or any non-null `signalQualityScore` on older versions).
- **Console:** when `hasInputData = false`, show "no data yet" instead of 14% / 19% / 0% — fabricated-looking percentages destroy operator trust.

### C3. Surface capture diagnostics + log tail
- 1.2.82 machines now send `userAgentLogTail` (last ~4KB of user-agent.log) and can report `capture_loop_stalled` / `capture_loop_erroring` failure codes.
- **Console machine detail drawer:** show captureFailureReason, self-test state, watchdog failure code, and a collapsible log-tail viewer. This is the "never touch a user's machine again" feature.

### C4. Self-test "pending" must expire
- **Where:** `fleetReadService.ts` derivation.
- A self-test stuck `pending` for >10 minutes while heartbeats are fresh means the evaluation loop is dead (today's root cause). Derive `selfTestEffective: 'stale_pending'` and have the console count it under DEGRADED CAPTURE, not healthy.

### C5. Version hygiene
- **Where:** `fleetReadService.ts` + console.
- Compare each machine's `agentVersion` to the latest release (from the client-release registry, fallback: highest version currently reporting). Add `outdated: boolean` + console badge (red for >2 minor versions behind) + a tile "X machines on outdated versions".
- Long-term (out of scope here, worth a future plan): agent auto-update.

### C6. Signup-state visibility
- **Console machines table:** explicit **NOT SIGNED IN** badge when `accountId` is null, instead of silently empty identity columns. Pairs with the A3 funnel: operators see who installed but never registered.

### C7. Console must distinguish "no data" from "not signed in" (console bug)
- An unauthenticated console session renders zeros ("0 machines", "All systems operational") instead of an auth prompt. Zeros that mean "you're logged out" are indistinguishable from a real outage. On 401 responses the console must show a session-expired state, never zero-filled dashboards.

---

## Implementation order

| Step | Repo | Risk | Depends on |
|---|---|---|---|
| 1. B1 active-day gate | control-plane | low | nothing |
| 2. A1 install events + A2 backfill | control-plane | low | nothing |
| 3. A3/A4 growth summary + series | control-plane | low | step 2 |
| 4. C1/C2/C4/C5 derived fields | control-plane | low | nothing |
| 5. A5/C3/C6/C7 console UI | operations-console | low | steps 3–4 + repo access |

Steps 1–4 are pure control-plane (auto-deploys on push to Render). Step 5 needs the `porta-operations-console` repo connected.

## What does NOT change
- Registered/activated/retention definitions (historical comparability)
- Agent code (1.2.82 already shipped)
- Database schema (growth_events and devices already hold everything; only new event rows)
- Existing API responses (all new fields additive/nullable — old console keeps working)
