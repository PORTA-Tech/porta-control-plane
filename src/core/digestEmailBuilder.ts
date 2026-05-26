export interface DailyDigestPayload {
  accountId?: string | null;
  deviceId: string;
  machineId: string;
  dateLocal: string;
  timezoneOffsetMinutes: number;
  reportedAtUtc: string;
  trackedSeconds: number;
  focusSeconds: number;
  focusQualityScore: number;
  distractionSeconds: number;
  awaySeconds: number;
  contextExcursionSeconds: number;
  longestFocusStreakSeconds: number;
  fragmentationEpisodeCount: number;
  socialMediaLoopCount: number;
  gamingEpisodeCount: number;
  socialMediaSeconds: number;
  gamingLauncherSeconds: number;
  gamingActiveSeconds: number;
  passiveConsumptionSeconds: number;
  commMonitoringReturnCount: number;
  socialMediaReturnCount: number;
  overloadEpisodeCount: number;
  breaksTakenCount: number;
  breaksSuggestedCount: number;
  mostDistractedHourLabel: string;
  developmentSeconds: number;
  productivitySeconds: number;
  communicationSeconds: number;
  entertainmentSeconds: number;
}

// ── Formatting helpers ──────────────────────────────────────────────────────

function fmtMinutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

function pct(num: number, denom: number): string {
  if (denom <= 0) return '0%';
  return `${Math.round((num / denom) * 100)}%`;
}

function focusGrade(score: number): { label: string; color: string } {
  if (score >= 0.8) return { label: 'Excellent', color: '#22c55e' };
  if (score >= 0.65) return { label: 'Good', color: '#84cc16' };
  if (score >= 0.45) return { label: 'Fair', color: '#f59e0b' };
  return { label: 'Low', color: '#ef4444' };
}

// ── Rule-based Ari observation ──────────────────────────────────────────────

function buildAriObservation(p: DailyDigestPayload): string {
  const focusPct = p.trackedSeconds > 0 ? p.focusSeconds / p.trackedSeconds : 0;

  // Priority 1: overload
  if (p.overloadEpisodeCount >= 3) {
    return `You hit overload ${p.overloadEpisodeCount} times today — that's your brain telling you it needed more recovery time. Tomorrow, try building a short buffer between dense tasks.`;
  }

  // Priority 2: missed breaks when suggested
  if (p.breaksSuggestedCount >= 2 && p.breaksTakenCount === 0) {
    return `Ari suggested ${p.breaksSuggestedCount} break${p.breaksSuggestedCount > 1 ? 's' : ''} today — none were taken. Skipping recovery consistently raises your overload risk. Even a 3-minute pause resets your focus clock.`;
  }

  // Priority 3: social media loops
  if (p.socialMediaLoopCount >= 5) {
    return `You returned to social media ${p.socialMediaLoopCount} times today. That kind of loop usually signals low-urgency avoidance. Consider blocking it during your peak focus window tomorrow.`;
  }

  // Priority 4: heavy fragmentation
  if (p.fragmentationEpisodeCount >= 6) {
    return `${p.fragmentationEpisodeCount} fragmentation episodes today means your attention kept splintering between tasks. Batching context-switches into deliberate windows can cut this in half.`;
  }

  // Priority 5: great focus streak
  if (p.longestFocusStreakSeconds >= 5400) {
    const streakLabel = fmtMinutes(p.longestFocusStreakSeconds);
    return `Your longest focus streak today was ${streakLabel} — that's strong deep work. Protect that same window tomorrow.`;
  }

  // Priority 6: low focus quality
  if (p.focusQualityScore < 0.45 && focusPct > 0.4) {
    return `You spent a lot of time "in focus" today, but Ari's quality signal stayed low — a sign of surface-level work rather than deep engagement. More breaks or fewer parallel tasks often fixes this.`;
  }

  // Priority 7: good day
  if (focusPct >= 0.6 && p.focusQualityScore >= 0.65) {
    return `Strong day — ${pct(p.focusSeconds, p.trackedSeconds)} focus time with good quality. Your distraction exposure was minimal. Keep the same rhythm tomorrow.`;
  }

  // Default
  return `You tracked ${fmtMinutes(p.trackedSeconds)} of activity today. Ari will build a clearer picture of your patterns as more days accumulate.`;
}

// ── Category bar helper ─────────────────────────────────────────────────────

function categoryBar(label: string, seconds: number, totalSeconds: number, color: string): string {
  const p = totalSeconds > 0 ? Math.round((seconds / totalSeconds) * 100) : 0;
  return `
    <tr>
      <td style="padding:5px 0;font-size:12px;color:#4a4a6a;width:120px;">${label}</td>
      <td style="padding:5px 8px;">
        <div style="background:#1a1a28;border-radius:4px;height:7px;width:100%;">
          <div style="background:${color};border-radius:4px;height:7px;width:${p}%;"></div>
        </div>
      </td>
      <td style="padding:5px 0;font-size:12px;color:#9090a8;text-align:right;white-space:nowrap;width:64px;">${fmtMinutes(seconds)} <span style="color:#3e3e5e;">${p}%</span></td>
    </tr>`;
}

// ── Main builder ────────────────────────────────────────────────────────────

export function buildDigestEmail(p: DailyDigestPayload, launchUrl = 'porta://open'): { subject: string; html: string } {
  const trackedLabel = fmtMinutes(p.trackedSeconds);
  const focusLabel = fmtMinutes(p.focusSeconds);
  const focusPctLabel = pct(p.focusSeconds, p.trackedSeconds);
  const grade = focusGrade(p.focusQualityScore);
  const streakLabel = fmtMinutes(p.longestFocusStreakSeconds);
  const ariObs = buildAriObservation(p);

  // Format date nicely: "Monday, 19 May 2025"
  let dateDisplay = p.dateLocal;
  try {
    const d = new Date(p.dateLocal + 'T00:00:00');
    dateDisplay = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    /* keep raw string */
  }

  const breakComplianceLabel =
    p.breaksSuggestedCount === 0
      ? 'No breaks suggested'
      : `${p.breaksTakenCount} of ${p.breaksSuggestedCount} taken`;

  const totalCategorySeconds =
    p.developmentSeconds + p.productivitySeconds + p.communicationSeconds + p.entertainmentSeconds;

  const subject = `Your Ari daily digest — ${dateDisplay}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ari Daily Digest</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI Variable', 'Segoe UI', Helvetica, Arial, sans-serif; }
</style>
</head>
<body style="margin:0;padding:0;background:#0a0a10;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI Variable','Segoe UI',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0a0a10;min-height:100vh;">
<tr><td align="center" style="padding:32px 16px;">

  <!-- Card -->
  <table width="600" cellpadding="0" cellspacing="0" border="0" style="background:#111118;border-radius:16px;overflow:hidden;max-width:600px;width:100%;border:1px solid #1e1e2e;">

    <!-- Header accent line -->
    <tr><td style="background:#3d3d7a;height:3px;font-size:0;line-height:0;">&nbsp;</td></tr>

    <!-- Header -->
    <tr>
      <td style="background:#111118;padding:28px 36px 24px;">
        <p style="margin:0 0 6px;font-size:11px;color:#5a5a8a;letter-spacing:0.1em;text-transform:uppercase;font-weight:500;">Ari by Porta</p>
        <h1 style="margin:0 0 5px;font-size:22px;font-weight:700;color:#dde1ef;">Your day at a glance</h1>
        <p style="margin:0;font-size:13px;color:#4a4a6a;">${dateDisplay}</p>
      </td>
    </tr>

    <!-- Section 1: Day at a glance -->
    <tr>
      <td style="padding:0 36px 0;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0e0e16;border-radius:10px;">
          <tr>
            <td style="text-align:center;padding:20px 8px 20px 0;">
              <p style="margin:0 0 4px;font-size:11px;color:#3e3e5e;text-transform:uppercase;letter-spacing:0.06em;">Tracked</p>
              <p style="margin:0;font-size:26px;font-weight:700;color:#c8cde0;">${trackedLabel}</p>
            </td>
            <td style="text-align:center;padding:20px 8px;border-left:1px solid #1a1a28;border-right:1px solid #1a1a28;">
              <p style="margin:0 0 4px;font-size:11px;color:#3e3e5e;text-transform:uppercase;letter-spacing:0.06em;">Focus</p>
              <p style="margin:0;font-size:26px;font-weight:700;color:#7878c0;">${focusLabel}</p>
              <p style="margin:0;font-size:12px;color:#3e3e5e;">${focusPctLabel} of day</p>
            </td>
            <td style="text-align:center;padding:20px 0 20px 8px;">
              <p style="margin:0 0 4px;font-size:11px;color:#3e3e5e;text-transform:uppercase;letter-spacing:0.06em;">Quality</p>
              <p style="margin:0;font-size:26px;font-weight:700;color:${grade.color};">${grade.label}</p>
              <p style="margin:0;font-size:12px;color:#3e3e5e;">${Math.round(p.focusQualityScore * 100)}/100</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Divider -->
    <tr><td style="padding:22px 36px 0;"><div style="height:1px;background:#1a1a28;"></div></td></tr>

    <!-- Section 2: Focus quality -->
    <tr>
      <td style="padding:20px 36px 0;">
        <p style="margin:0 0 14px;font-size:11px;font-weight:600;color:#6060a8;text-transform:uppercase;letter-spacing:0.1em;">Focus Quality</p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="padding:0 16px 0 0;">
              <p style="margin:0 0 2px;font-size:12px;color:#3e3e5e;">Longest streak</p>
              <p style="margin:0;font-size:19px;font-weight:600;color:#c8cde0;">${streakLabel}</p>
            </td>
            <td style="padding:0 16px;border-left:1px solid #1a1a28;">
              <p style="margin:0 0 2px;font-size:12px;color:#3e3e5e;">Fragmentation</p>
              <p style="margin:0;font-size:19px;font-weight:600;color:#c8cde0;">${p.fragmentationEpisodeCount} <span style="font-size:12px;color:#3e3e5e;">episodes</span></p>
            </td>
            <td style="padding:0 0 0 16px;border-left:1px solid #1a1a28;">
              <p style="margin:0 0 2px;font-size:12px;color:#3e3e5e;">Context switches</p>
              <p style="margin:0;font-size:19px;font-weight:600;color:#c8cde0;">${fmtMinutes(p.contextExcursionSeconds)}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Divider -->
    <tr><td style="padding:20px 36px 0;"><div style="height:1px;background:#1a1a28;"></div></td></tr>

    <!-- Section 3: Distraction patterns -->
    <tr>
      <td style="padding:20px 36px 0;">
        <p style="margin:0 0 14px;font-size:11px;font-weight:600;color:#b06030;text-transform:uppercase;letter-spacing:0.1em;">Distraction Patterns</p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="padding:0 12px 0 0;vertical-align:top;">
              <p style="margin:0 0 2px;font-size:12px;color:#3e3e5e;">Total distraction</p>
              <p style="margin:0;font-size:18px;font-weight:600;color:#c07040;">${fmtMinutes(p.distractionSeconds)}</p>
            </td>
            <td style="padding:0 12px;border-left:1px solid #1a1a28;vertical-align:top;">
              <p style="margin:0 0 2px;font-size:12px;color:#3e3e5e;">Social media loops</p>
              <p style="margin:0;font-size:18px;font-weight:600;color:#c8cde0;">${p.socialMediaLoopCount}×</p>
              <p style="margin:0;font-size:11px;color:#3e3e5e;">${fmtMinutes(p.socialMediaSeconds)}</p>
            </td>
            <td style="padding:0 0 0 12px;border-left:1px solid #1a1a28;vertical-align:top;">
              <p style="margin:0 0 2px;font-size:12px;color:#3e3e5e;">Gaming</p>
              <p style="margin:0;font-size:18px;font-weight:600;color:#c8cde0;">${fmtMinutes(p.gamingLauncherSeconds + p.gamingActiveSeconds)}</p>
              <p style="margin:0;font-size:11px;color:#3e3e5e;">${p.gamingEpisodeCount} episodes</p>
            </td>
          </tr>
        </table>
        ${p.mostDistractedHourLabel && p.mostDistractedHourLabel !== 'n/a'
          ? `<p style="margin:12px 0 0;font-size:13px;color:#5a5a7a;">Most distracted hour: <span style="color:#c07040;font-weight:600;">${p.mostDistractedHourLabel}</span></p>`
          : ''}
      </td>
    </tr>

    <!-- Divider -->
    <tr><td style="padding:20px 36px 0;"><div style="height:1px;background:#1a1a28;"></div></td></tr>

    <!-- Section 4: Pressure & Breaks -->
    <tr>
      <td style="padding:20px 36px 0;">
        <p style="margin:0 0 14px;font-size:11px;font-weight:600;color:#8a406a;text-transform:uppercase;letter-spacing:0.1em;">Pressure &amp; Breaks</p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="padding:0 16px 0 0;">
              <p style="margin:0 0 2px;font-size:12px;color:#3e3e5e;">Overload episodes</p>
              <p style="margin:0;font-size:19px;font-weight:600;color:${p.overloadEpisodeCount >= 3 ? '#c04055' : '#c8cde0'};">${p.overloadEpisodeCount}</p>
            </td>
            <td style="padding:0 0 0 16px;border-left:1px solid #1a1a28;">
              <p style="margin:0 0 2px;font-size:12px;color:#3e3e5e;">Break compliance</p>
              <p style="margin:0;font-size:19px;font-weight:600;color:#c8cde0;">${breakComplianceLabel}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Divider -->
    <tr><td style="padding:20px 36px 0;"><div style="height:1px;background:#1a1a28;"></div></td></tr>

    <!-- Section 5: App category breakdown -->
    <tr>
      <td style="padding:20px 36px 0;">
        <p style="margin:0 0 14px;font-size:11px;font-weight:600;color:#207a80;text-transform:uppercase;letter-spacing:0.1em;">Time Breakdown</p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${categoryBar('Development', p.developmentSeconds, totalCategorySeconds, '#5858a0')}
          ${categoryBar('Productivity', p.productivitySeconds, totalCategorySeconds, '#207a80')}
          ${categoryBar('Communication', p.communicationSeconds, totalCategorySeconds, '#287858')}
          ${categoryBar('Entertainment', p.entertainmentSeconds, totalCategorySeconds, '#a05830')}
        </table>
      </td>
    </tr>

    <!-- Divider -->
    <tr><td style="padding:20px 36px 0;"><div style="height:1px;background:#1a1a28;"></div></td></tr>

    <!-- Section 6: Ari observation -->
    <tr>
      <td style="padding:20px 36px 0;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="background:#0e0e16;border-left:3px solid #3d3d7a;border-radius:0 8px 8px 0;padding:14px 16px;">
              <p style="margin:0 0 6px;font-size:11px;font-weight:600;color:#5a5a8a;text-transform:uppercase;letter-spacing:0.1em;">Ari's observation</p>
              <p style="margin:0;font-size:14px;color:#9a9aae;line-height:1.6;">${ariObs}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- CTA -->
    <tr>
      <td style="padding:28px 36px 32px;text-align:center;">
        <a href="${launchUrl}" style="display:inline-block;background:#2a2a5a;color:#a0a0d0;text-decoration:none;font-size:14px;font-weight:600;padding:12px 36px;border-radius:8px;letter-spacing:0.04em;border:1px solid #3d3d7a;">Open Ari</a>
      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td style="background:#0a0a10;padding:16px 36px;text-align:center;border-radius:0 0 16px 16px;border-top:1px solid #1a1a28;">
        <p style="margin:0;font-size:11px;color:#2a2a3e;">Sent by Ari · <a href="https://useporta.com" style="color:#3a3a5a;text-decoration:none;">useporta.com</a></p>
      </td>
    </tr>

  </table>
  <!-- End card -->

</td></tr>
</table>
</body>
</html>`;

  return { subject, html };
}
