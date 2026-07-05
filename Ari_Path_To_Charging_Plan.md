# Ari — Path to Charging: Build Plan

The goal of this plan: get Ari to the point where it's reliable, accurate, and lovable
enough to charge for — in the right order, where each step unblocks the next. Sequenced so
we never build a data/ML feature before the data exists, and never ship a feature to a fleet
that can't receive it.

Current state (as of 1.2.101):
- Shipped: digest accuracy (real categories + named apps), per-app capture pipeline, meeting
  shield (lite), state-driven breaks, recovery / first-win / cold-start toasts, live
  current-app name in summary, per-app category attribution + "what pulled you off task".
- Known issues feeding this plan: (1) fleet auto-update was 404-ing (manifest pointed at the
  private source repo); (2) pressure/overload caps ~0.50 and never uses its top half;
  (3) there are ZERO ground-truth labels anywhere in the system.

---

## Phase 0 — Unblock delivery (now, hours)

Nothing else matters until machines can auto-update. THOR's log proved the cause:
`agent_update_download_failed … 404` because the manifest's MSI URL points at the private
`porta-agent-windows-x64` repo and the agent downloads anonymously.

- [ ] Change Render `PORTA_WINDOWS_RELEASE_MSI_URL` to the public repo:
      `https://github.com/PORTA-Tech/porta-windows-releases/releases/download/v1.2.101/AriAgentInstaller.msi`
      (VERSION 1.2.101 and SHA256 96d30cba… stay the same — same file).
- [ ] Add to the release checklist permanently: publish the MSI to BOTH repos each release,
      and point the manifest at the **public** one.
- [ ] **Done when:** a machine (THOR or sana) moves to 1.2.101 on its own, no manual install.

Dependencies: none. Blocks: everything.

---

## Phase 1 — Accuracy foundation + seed the future (week 1–2)

The "make Ari more accurate before charging" gate. This is heuristics + data plumbing, NOT ML.

- [ ] **1a. Fix the pressure model.** It caps ~0.50 because the strain floors only fire on
      multitasking (≥3 app-switches / ≥4 apps); sustained single-app intensity never moves it.
      Add a sustained-on-task intensity term and recalibrate against the fleet pressure
      distributions we now have. Re-point the break `BreakNeed*` thresholds off the real range
      (remove the 0.45 stopgap). Fix/replace the permanently-empty "Overload pressure" console
      bucket. Files: `OverloadInferenceComputer.ComputePressureLevel`, `PortaExecutionConstants`.
      **Done when:** pressure spans a realistic range under genuine load; overload bucket lights
      up when it should.
- [ ] **1b. Start capturing ground-truth labels (critical — gates the future LM).** Today
      nothing records whether Ari's guesses were right. Add a light hook: record
      accept/dismiss on the recovery & break nudges, plus an occasional one-tap "were you
      focused just now? 👍/👎". Store per-bucket. **Done when:** labels are accumulating in a
      table. (Without this, the learned model in Phase 6 can never exist.)
- [ ] **1c. Finish 2.6 signup nudge** (widget toast: unlinked + ≥2 days local data, weekly
      cap). Funnel fix — 70% never sign up today, and you can't charge people who never
      registered. Needs the local days-of-data source + link status into the UserAgent.

Dependencies: Phase 0. Blocks: charging (1a, 1c), the LM (1b).

---

## Phase 2 — The "love it" features (week 2–3)

The things real users asked for that are broadly valuable, not bespoke.

- [ ] **2a. Widget pulse / "alive".** Highest ROI on the whole plan: directly fixes the
      "looks inert" churn risk and makes the product feel worth paying for. Small build.
- [ ] **2b. Meeting measurement (Sana).** When a meeting app is foreground, treat low input
      as *attentive-in-meeting* rather than idle/distraction — so meetings are measured, not
      excluded. **Hard limit to communicate:** without mic/camera (which would break consent)
      we cannot tell "listening" from "away"; this heuristic is the consent-safe ceiling.
- [ ] **2c. Reminder pill on the widget.** Light, no calendar — scratches Thor's "remind me
      of upcoming things" itch and is a precursor to the paid calendar feature.
- [ ] **2d. LLM app-categorizer.** Replace the hand-maintained `AppCategoryClassifier` list:
      send each *new* coarse label ("claude", "notion", a site token) to an LLM once, cache the
      category server-side forever. Fixes the "claude was Unknown" class of problem generally
      and makes category/distraction accuracy scale without hand-maintaining lists. Cheap
      (one call per never-seen token). This is the first AI in the product and it improves
      accuracy now.

Dependencies: Phase 0 (delivery), 2d benefits from Phase 1a categories being trustworthy.

---

## Phase 3 — Watch & validate willingness to pay (parallel, week 2–4)

- [ ] Watch the now-real metrics: D1/D7 retention, install→signup funnel, digest opens,
      capture health at scale.
- [ ] **Pricing-intent test before building billing:** show "free during beta, $X/mo after"
      in-product and measure usage drop-off — real willingness-to-pay behavior, not one user
      being nice. Run this the same week Phase 3 starts.
- [ ] Tune nudge frequency/copy from this data, not instinct.

Dependencies: Phase 0 (real fleet data flowing).

---

## Phase 4 — Charge (when gates are met)

Charge only when ALL of these are true:
- Delivery is reliable (Phase 0 holding for 2+ weeks).
- Signal is accurate (Phase 1a done).
- Love-features shipped (2a, 2b, signup nudge).
- Retention proven and pricing-intent positive (Phase 3).

- [ ] Build minimal billing/subscription.
- [ ] **Done when:** first paying user.

---

## Phase 5 — Premium layer (post-charge)

- [ ] **LLM coaching / natural-language digest narrative** — makes Ari *sound* smart;
      premium-tier differentiator.
- [ ] **Calendar integration + forecasting (Thor)** — OAuth, "front-load your high-pressure
      afternoon". New privacy scope; premium feature. Needs Phase 1 history to avoid horoscopes.

---

## Phase 6 — Earned-by-data features (months out)

These literally cannot exist until data accrues; don't start early.

- [ ] **LM (learned pressure/focus model)** — train on the labels from Phase 1b. Replaces
      heuristic inference once there's enough signal.
- [ ] **Focus Shield (proactive blocking)** — opt-in "Shield mode", conservative thresholds,
      built only after the fixed pressure model + weeks of calibrated/labeled data. A single
      false block burns trust permanently, so this waits.
- [ ] **App-reputation learning** — per-user productive-vs-destructive learning; needs weeks
      of per-user data.

---

## The one-line sequence

Fix delivery → fix pressure + start labels + signup nudge → pulse + meeting-measurement +
LLM categorizer → watch data + pricing test → charge → LLM coaching/calendar premium → LM +
Focus Shield + app-rep once the data has earned them.

## AI timing, settled
- **LLM = now** (app-categorizer for accuracy; light coaching for feel) — before charging.
- **LM = later** (needs Phase 1b labels you don't have yet) — after charging.
- Don't reach for an LLM to fix core signal accuracy; that's the pressure-model + calibration job.
