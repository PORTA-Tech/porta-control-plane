# PORTA / Ari — Launch Plan
**Target: public launch in ~4 weeks · Written 2026-06-10**

The single principle behind this plan: **a new user decides in their first week, and their first week is cold-start.** Everything pre-launch either makes the first week work, or makes it possible to fix things after launch without touching users' machines. Everything that needs calibrated baselines ships after launch, delivered by auto-update.

---

## WEEK 1 — Foundation (nothing new, everything solid)

### 1.1 Fleet stability watch
1.2.82 is live. For 5–7 days, verify daily from the console:
- every online machine keeps `hasInputData = true` (capture stays alive, not just heartbeats)
- digest emails send every day — both paths (agent at 19:30 UTC, server cron fallback at 20:30 UTC)
- log tails stay clean (no `capture_loop_*`, no self-test failures)
- Aymene's machine progresses cold → provisional (proves calibration pipeline works end-to-end)

**Exit criterion: 7 consecutive days where every online machine collects data and every eligible account gets a digest. No launch until this holds.**

### 1.2 Code-signing certificate — START IMMEDIATELY
The MSI is unsigned. Windows SmartScreen will warn every launch-day downloader with "unrecognized app". OV/EV certificates take days-to-weeks to issue and reputation takes time to build — this is the longest lead-time item in the whole plan. Order it this week.

### 1.3 Auto-update
The highest-leverage engineering work before launch. Today a fix means: build MSI → upload to Drive → update website → beg users to re-download. After launch that's fatal.
- Agent checks the control plane's client-release endpoint daily (the registry already exists)
- Downloads new MSI, verifies signature + SHA256, installs silently via the service
- Staged rollout flag on the control plane (10% → 50% → 100%) so a bad release can't brick the fleet
**Definition of done: ship a trivial 1.2.83, watch the entire fleet update itself within 24h with zero user action.**

### 1.4 Security lock-down
- Real authentication on all `/v1` operator endpoints (header-only auth is currently open to anyone)
- Rotate the database password
- Verify CORS and rate limits on public endpoints

---

## WEEKS 2–3 — Product (the first-week experience)

### 2.1 End-of-day digest v2 *(already building — flagship)*
One clean email: how the day went, the best focus window, one thing to try tomorrow.
**Upgrade — maturing insight lines.** The digest gets smarter as data accumulates, and SAYS so:
- Day 1–3: honest basics — "Ari is still learning your rhythm (day 2 of ~5)"
- Week 2+: **focus identity** — "You do your best work Tuesday and Wednesday mornings" (weakHour / strong windows already computed in user_history — this is wiring, not modeling)
- Week 2+: **pattern naming** — "You tend to drift after ~40 minutes in one app" (focus-hash dwell times already captured)
This absorbs two features from the original list as digest content instead of separate builds.

### 2.2 "You were close" recovery nudge *(new build — the first-session magic)*
When a distraction episode ends and the user returns: "You were 18 minutes into a strong focus run — pick it back up?"
- Trigger: focus episode ≥ 10 min ends by distraction → user input resumes
- Needs zero calibration → works in the user's very first session (the only "felt magic" feature that does)
- Cap: max 2–3/day, never twice within an hour (a nag is worse than nothing)

### 2.3 Context-aware break timing *(refinement — anti-annoyance)*
Never interrupt a flow state. Hold break suggestions until a natural pause: app switch, idle dip, episode boundary, with a hard timeout (if no pause within ~10 min, show anyway). Defensive feature: interrupting flow is an uninstall trigger.

### 2.4 Meeting shield — lite *(small build)*
When a meeting app (Zoom/Teams/Meet/Slack huddle) is the foreground app, don't count it as distraction and pause break nudges. App-category classifier already exists. **Explicitly out of scope: audio/microphone detection — a monitoring product asking for mic access reads as spyware.**

### 2.5 Cold-start experience *(new — fixes the biggest churn risk)*
The first week is cold for every new user; today the product just looks inert. Two small things:
- **First-win moment:** after the first real focus episode (~30–60 min in), one toast: "That was your first tracked focus run — 24 minutes. Your daily summary arrives tonight." Proof of life, day one.
- **Visible calibration:** Control Center shows "Learning your patterns — day 2 of ~5" instead of empty zeros. Sets expectations; a user who knows it's learning doesn't uninstall because "it does nothing".

### 2.6 Signup nudge *(small build — funnel fix)*
70% of installs never sign up → never get a digest → silent churn (today's funnel: 30%).
After ~2 days of local data: "Ari tracked 9 hours of focus this week — create an account to get your daily summary by email." One dismissible prompt, value-first, repeated at most weekly. **Watch `install_to_registration_rate_pct` move.**

---

## WEEK 4 — Launch readiness (no new code)

- **The journey test:** fresh Windows machine (not yours) → website → download → install → sign up → use one day → digest arrives. Run it with at least 2 non-technical strangers; watch them, don't help them.
- Signed MSI through the full flow (SmartScreen behavior verified)
- Auto-update proven on the real fleet
- Load sanity: Render Starter instance + Postgres with 10× current machines reporting every 30s
- Support basics: a help email, a "something's wrong" path that isn't "message Yadin"
- Console daily ritual defined: funnel, capture health, digest delivery — 5 minutes every morning

---

## POST-LAUNCH (delivered via auto-update)

**Phase 1 (launch +2–6 weeks) — watch and tune.** Funnel conversion, D1/D7 retention (now real), digest open behavior, capture health at scale. Tune nudge frequency/copy from data, not instinct.

**Phase 2 — Focus Shield (proactive distraction blocking).** The original list's #1, deliberately delayed: it depends on pressure signals you've only had fleet-wide since today, and a false-positive block burns trust permanently. Build it opt-in ("Shield mode"), conservative thresholds, after watching real pressure data across many calibrated users for several weeks.

**Phase 3 — App reputation learning.** Per-user productive-vs-destructive app learning. Needs weeks of per-user data — literally cannot exist at launch; natural once a real user base generates training signal.

**Phase 4 — Pressure forecasting + calendar.** "Today looks like a high-pressure afternoon — front-load deep work?" Requires calendar OAuth (new privacy surface, real scope) and enough history for forecasts that don't feel like horoscopes. Strongest as a premium-tier feature later.

---

## What was cut or changed from the original list, and why

| Original feature | Verdict | Why |
|---|---|---|
| Proactive distraction blocking | Post-launch P2 | Needs weeks of fleet pressure data; false positives kill trust |
| Context-aware break timing | **Pre-launch** | Anti-annoyance; protects retention |
| Recovery nudges | **Pre-launch** | Only magic feature that works day one |
| Weekly focus identity | **Pre-launch, inside digest** | Data already computed; not a separate feature |
| Distraction pattern naming | **Pre-launch, inside digest** | Same |
| Pressure forecasting | Post-launch P4 | Calendar integration is a project; weak v1 breaks trust |
| Auto-pause meetings | **Pre-launch, app-detection only** | Audio/mic = spyware optics; app detection is 90% of value |
| App reputation learning | Post-launch P3 | Cannot exist without weeks of user data |
| End-of-day digest | **Pre-launch flagship** | The retention loop and signup carrot |
| *(added)* Auto-update | **Pre-launch, week 1** | Makes every future fix and feature deliverable |
| *(added)* Cold-start experience | **Pre-launch** | First week is cold for everyone; inertia is the top churn risk |
| *(added)* Signup nudge | **Pre-launch** | 70% of installs currently leak out before value |
| *(added)* MSI signing + API auth | **Pre-launch, week 1** | Launch blockers, not features |

## The one-line version
**Week 1: make it unbreakable and updatable. Weeks 2–3: make the first week feel alive (digest, recovery nudge, cold-start moments, signup nudge). Week 4: prove the whole journey on strangers. After launch: ship the deep magic through auto-update as real data earns it.**
