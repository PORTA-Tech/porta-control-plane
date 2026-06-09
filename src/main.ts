import { createApp, initializeControlPlane } from './app.js';
import { runDailyDigestCron } from './core/digestCronService.js';

initializeControlPlane();
const app = createApp();

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`[control-plane] listening on :${port}`);
});

// Server-side digest cron: fires at 20:30 UTC daily.
// Sends fallback digest emails to accounts whose machines were off at 19:30 UTC.

function shouldRunCron(now: Date): boolean {
  return now.getUTCHours() === 20 && now.getUTCMinutes() >= 30 && now.getUTCMinutes() < 35;
}

let cronRanToday = false;
let lastCronDate = '';

setInterval(() => {
  const now = new Date();
  const todayUtc = now.toISOString().slice(0, 10);
  if (todayUtc !== lastCronDate) {
    cronRanToday = false;
    lastCronDate = todayUtc;
  }
  if (!cronRanToday && shouldRunCron(now)) {
    cronRanToday = true;
    runDailyDigestCron().catch((err: unknown) => {
      console.error('[digest-cron] Unhandled error:', err instanceof Error ? err.message : String(err));
    });
  }
}, 60_000);

// Startup catch-up: run immediately if server restarts inside the 20:30-23:59 UTC window.
(function startupCatchUp() {
  const now = new Date();
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  if ((h === 20 && m >= 30) || h > 20) {
    console.log('[digest-cron] Startup catch-up triggered.');
    cronRanToday = true;
    lastCronDate = now.toISOString().slice(0, 10);
    runDailyDigestCron().catch((err: unknown) => {
      console.error('[digest-cron] Startup catch-up error:', err instanceof Error ? err.message : String(err));
    });
  }
}());
