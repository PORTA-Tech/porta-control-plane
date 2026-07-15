# Ari — Two-Week Pre-Launch Focus Plan

**Written 2026-07-15 · ~2 weeks to launch · one founder**

This plan does not replace `Launch_Plan.md` or `Ari_Path_To_Charging_Plan.md` — those stay the technical roadmap. This is the **re-centering** for the next two weeks, based on what the console and the code actually show today.

---

## What we now know (the honest baseline)

- **The product works on live machines.** AYMENE (signed in, latest version) reports ONLINE · ACTIVE · capturing right now. The agent is not the problem.
- **The console overstated the alarm.** "1 healthy / 9 disconnected of 13" counted nine churned installs from May–June as red alarms. Of the machines actually in play, capture works. (Fixed — see below.)
- **The real fleet is ~2 live users** (you + Aymene actively), a couple more intermittently, and ~7 dormant installs. Only **1 new registration in the last 30 days.**
- **The binding constraint is not features — it's distribution and learning.** "People don't want to get involved because I'm a nobody" is the actual reason growth stalled, not positioning or missing features. You already feel this ("tired of building features they don't want").
- **The strategy is right:** charge as a *learning instrument* → if no, learn why → give them that and re-ask → if yes, scale. Refined below.
- **The market question is genuinely open** (individual B2C vs. team/B2B). Do not pivot on a hunch. Run both as cheap probes and let pull decide.

---

## Console fixes made this session (operations-console repo)

All changes are console-only, additive, low-risk. **Run `npm run check && npm test` locally before deploying** — the sandbox couldn't give a clean compile this session due to a file-mount glitch, so local verification is the authoritative gate.

1. **Active-fleet segmentation** (`src/utils/fleetTruth.ts`, `SystemHealthPage.tsx`). New `isDormant()` + `summarizeFleetHealth()`. Installs offline > 7 days are counted as **dormant installs**, excluded from the health tiles and the denominator. "Healthy" now reads "of N active machines," and the red Disconnected tile shows only recently-offline machines with a "N dormant installs excluded" note. Churn stops masquerading as an agent-health fire.
2. **Stale errors no longer render as current** (`SystemHealthPage.tsx`). A dormant machine's months-old error string (e.g. DANISH's `USER_AGENT_SESSION_SWITCHED`) is suppressed — the Status column already says how long it's been gone.
3. **Activation card is now internally consistent** (`GrowthPage.tsx`). The headline % is derived from the exact "activated / registered" fraction shown beneath it, so it can never again show "100%" next to "1/6." Color reflects the real rate (red/amber/green), not always-green.

**Deferred on purpose — tester exclusion.** Your own account and internal test machines still count in the growth numbers. Excluding them changes growth *definitions* (which your accuracy plan deliberately froze for historical comparability), so it belongs in the control-plane as a tagged "internal" flag, not a console hack. Recommend: add an `is_internal` tag to known tester accounts/emails and show growth headline %s with them excluded (with a visible "excludes N internal" note). Flagged for your decision.

---

## The two-week plan

### Days 1–3 — Make the instrument honest, confirm delivery
- Deploy the console fixes above (after local `npm run check && npm test`).
- **Verify auto-update actually holds.** The live machines are all on 1.2.114 (good sign), but the dormant ones are scattered across 1.0.38 → 1.2.110. Ship a trivial version bump and confirm a machine updates itself on next wake with zero user action. This is Phase 0 of your charging plan and it gates every fix/feature you'd ship to users in the next weeks.
- Confirm digests are firing daily for the live accounts.

### Days 3–12 — Two parallel tracks (this is the real work)

**Track A — Individual users (B2C probe).**
- Goal: get **5–10 real people** to install and stick for a week. Treat "can I even get them in?" as the #1 experiment — if you can't, no feature fixes it, and that's the finding.
- Lowest-friction path: warm intros, your testers' networks, and one or two communities where the *nightly digest* would resonate (focus/deep-work/indie-maker circles). You being "a nobody" is exactly why cold posting fails — borrow trust, don't broadcast.
- With everyone who engages, run the **pricing-intent probe** (show "free during beta, $X/mo after," watch reaction) and a **structured "why / why not"** conversation. Do **not** build billing.

**Track B — One team / manager (B2B probe).**
- Try to land **one manager or small team** as a design partner. Your operations console *is* already a manager dashboard, and Ari's no-content-capture design is the honest "team focus & wellbeing, not surveillance" angle creepy competitors can't match.
- If a manager leans in and would pay per-seat while individuals shrug, the market just answered your biggest question.

### Launch day (~2 weeks out) — reframed
- Treat "launch" as a **beta expansion to 10–20 real users + the first paid-intent conversations**, not a public splash. Save the public launch (signed MSI, proven funnel, proven auto-update) for when those are ready — don't burn the one launch moment.
- You'll walk in with **truthful metrics + a handful of real reasons** and decide the direction from evidence.

---

## Do NOT build in these two weeks
Resist the instinct that got you here. The next two weeks are ~1 build (console truth + verify auto-update) and mostly **distribution + conversations.** In particular, do not start:
- The co-pilot / plan-vs-reality reorientation (it's a *hypothesis to test*, not a commitment).
- Any Phase 5/6 item (LLM coaching, calendar, LM, Focus Shield, app-rep).
- New first-week features beyond what's already shipped — confirm the leak is what you think *by talking to users* before building the fix.

---

## The strategic questions we are deliberately keeping open
1. **Who is the buyer** — the individual, or the manager/team? Decide from the two probes, not from theory.
2. **What is the job** — passive data (rear-view) vs. an active companion (co-pilot)? The requests point at co-pilot, but that's still a hypothesis until paying/near-paying users confirm it.
3. **Does anyone pay** — and *why / why not*? This is the actual deliverable of the two weeks.

The good news: because Ari already *sees* the user's activity, if the answer is "make it active," you can implement it fast. So there is no rush to commit now, and no wrong turn taken yet. The point of these two weeks is to earn the evidence to choose well.

## Success criteria (learning, not features)
By launch day you should be able to write one page answering:
- How many real users did I get in, through which channel, and how many stuck a week?
- Of the people who used it, how many would pay — and the *specific reason* each said yes or no?
- Did any manager/team lean in?
- Is the honest retention of *engaged* users good or not?

If you can answer those, the two weeks succeeded — regardless of the MRR.

---

## Captured for later — post-launch technical backlog

Not for the two weeks. Recorded so it isn't forgotten once the user base changes.

### Per-user timezone for the daily digest (fix when the first non-UAE user arrives)
- **What's hardcoded today:** the entire digest pipeline assumes Dubai (UTC+4). The agent stamps `timezoneOffsetMinutes: DubaiOffsetMinutes` as a constant and computes `dateLocal` from a fixed +4 offset (`DailyStatsReporter.cs`, `DailyDigestReporter.cs`); the server cron derives its target date from the same fixed +4 (`digestCronService.ts`); the agent's nightly send fires at "23:30 Dubai."
- **Why it's fine now:** every current user is in the UAE, which has no daylight saving and is permanently UTC+4, so the two fixes we just shipped (the cron off-by-one and the 1-hour dedup buffer) are correct and need no change.
- **Why it breaks at launch:** the whole point of launching is users outside the UAE. For them, "their day" is computed on Dubai's clock — the day boundary cuts at the wrong local time and the digest lands at an odd local hour. A user in New York would get a digest summarizing a day that ended on Dubai's midnight, not theirs.
- **The fix (already half-enabled):** the agent already sends each user's real offset in the digest payload (`timezoneOffsetMinutes`). The work is to *persist and use per-account offset* instead of the global constant in four places: (1) the agent's `dateLocal` stamping, (2) `daily_stats.date_local`, (3) the cron's target-date computation, (4) the send-time scheduling so each user's digest fires near their own end-of-day, not a single global UTC minute. This turns the one global cron into per-timezone (or per-account) send windows.
- **When:** post-launch, triggered by the first non-UAE signup. Do NOT do it pre-launch — it's real work and adds nothing while everyone's in Dubai.
