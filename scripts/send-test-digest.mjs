/**
 * Sends ONE digest email to an address you name, built by the real builder from a payload you
 * can edit at the bottom of this file. For looking at the design in a real inbox — Gmail's
 * renderer is not a browser, and the strip is a table of coloured cells.
 *
 * It never touches digest_log, so sending one does NOT consume the once-per-account-per-day
 * dedup and does NOT suppress tonight's real digest.
 *
 * ARI'S TAKE only appears if ANTHROPIC_API_KEY is also set (and the board shows an outcome) —
 * without the key the section is omitted by design, exactly as it is on the server.
 *
 * Usage (from the porta-control-plane directory, after `npm run build`):
 *   $env:RESEND_API_KEY = "<the key from the Render dashboard>"
 *   node scripts/send-test-digest.mjs you@example.com
 *
 * Pass `--no-timeline` to send the shape an agent BELOW 1.2.140 produces: no dayTimeline, so
 * THE DAY section is omitted. That is what the fleet sends until 1.2.140 is installed.
 */
import { buildDigestEmail } from '../dist/core/digestEmailBuilder.js';
import { sendEmail } from '../dist/core/emailService.js';

const to = process.argv.find((a) => a.includes('@'));
const withoutTimeline = process.argv.includes('--no-timeline');

if (!to) {
  console.error('Usage: node scripts/send-test-digest.mjs you@example.com [--no-timeline]');
  process.exit(1);
}
if (!process.env.RESEND_API_KEY) {
  console.error('RESEND_API_KEY is not set — nothing would send. Set it and run again.');
  process.exit(1);
}

const payload = {
  accountId: 'test-digest',
  deviceId: 'test',
  machineId: 'TEST',
  dateLocal: new Date().toISOString().slice(0, 10),
  timezoneOffsetMinutes: 240,
  reportedAtUtc: new Date().toISOString(),
  trackedSeconds: 30900,           // 8h 35m
  focusSeconds: 23940,             // 6h 39m
  focusQualityScore: 0.72,
  distractionSeconds: 2100,
  awaySeconds: 6960,               // 1h 56m
  contextExcursionSeconds: 0,
  longestFocusStreakSeconds: 6720, // 1h 52m
  fragmentationEpisodeCount: 4,
  socialMediaLoopCount: 2,
  gamingEpisodeCount: 0,
  socialMediaSeconds: 660,
  gamingLauncherSeconds: 0,
  gamingActiveSeconds: 0,
  passiveConsumptionSeconds: 0,
  commMonitoringReturnCount: 0,
  socialMediaReturnCount: 2,
  overloadEpisodeCount: 0,
  breaksTakenCount: 0,
  breaksSuggestedCount: 6,
  mostDistractedHourLabel: '14:00-14:59',
  developmentSeconds: 0,
  productivitySeconds: 0,
  communicationSeconds: 0,
  entertainmentSeconds: 0,
  topApps: [
    { label: 'claude', seconds: 16020, category: 2 },
    { label: 'github', seconds: 3840, category: 2 },
    { label: 'googledocs', seconds: 2520, category: 2 },
    { label: 'render', seconds: 1080, category: 2 },
    { label: 'youtube', seconds: 1440, category: 1 },
    { label: 'twitter', seconds: 660, category: 3 },
  ],
  tasks: [
    { title: 'Pricing page', plannedSeconds: 7200, actualSeconds: 4020, offtaskSeconds: 480, state: 'done', deferredUntilDay: '' },
    { title: 'Client revisions', plannedSeconds: 3600, actualSeconds: 1140, offtaskSeconds: 60, state: 'pending', deferredUntilDay: '2026-08-12' },
  ],
  ...(withoutTimeline ? {} : {
    dayTimeline: [
      { hourLocal: 8, focusSeconds: 1980, activeSeconds: 900, awaySeconds: 720 },
      { hourLocal: 9, focusSeconds: 3120, activeSeconds: 300, awaySeconds: 180 },
      { hourLocal: 10, focusSeconds: 2400, activeSeconds: 900, awaySeconds: 300 },
      { hourLocal: 11, focusSeconds: 3000, activeSeconds: 360, awaySeconds: 240 },
      // 12:00 and 13:00 absent on purpose — the machine was off. That is the gap.
      { hourLocal: 14, focusSeconds: 2280, activeSeconds: 720, awaySeconds: 600 },
      { hourLocal: 15, focusSeconds: 3240, activeSeconds: 180, awaySeconds: 180 },
      { hourLocal: 16, focusSeconds: 2820, activeSeconds: 480, awaySeconds: 300 },
      { hourLocal: 17, focusSeconds: 1800, activeSeconds: 900, awaySeconds: 900 },
      { hourLocal: 18, focusSeconds: 1200, activeSeconds: 600, awaySeconds: 1800 },
    ],
  }),
};

const { subject, html } = await buildDigestEmail(payload, 'https://useporta.com/app');
const sent = await sendEmail({ to, subject, html });

console.log(sent ? `Sent to ${to}: ${subject}` : 'Resend refused it — see the error above.');
process.exit(sent ? 0 : 1);
