/**
 * Rate limiting for the public download-request form (2026-08-26).
 *
 * SECURITY_HANDOFF §3 records that per-IP rate limiting was built and deleted, because IP is not
 * identity and a guessed limit silently breaks real agents. That reasoning is about the AGENT
 * API and still holds there. This is a different case and was asked for explicitly:
 *
 *   - the caller is an anonymous human filling a marketing form, not a fleet device;
 *   - the endpoint spends money and inbox reputation on every call, so it cannot be uncapped;
 *   - the failure is loud and recoverable — the person sees "try again shortly" and retries —
 *     rather than an agent quietly failing to report.
 *
 * THE NUMBERS ARE A POLICY CHOICE, NOT A MEASUREMENT. There is no traffic to measure yet. A
 * human submits this form once, or twice or three times after a typo. Five per hour clears that
 * with room to spare, and the global ceiling bounds the total spend if someone rotates addresses.
 * Both are env-overridable so a wrong guess is a config change, not a deploy.
 */

const DEFAULT_MAX_PER_IP_PER_HOUR = 5;
const DEFAULT_MAX_PER_HOUR = 100;
const WINDOW_MS = 60 * 60 * 1000;

interface Bucket {
  count: number;
  windowStartedAt: number;
}

const perIp = new Map<string, Bucket>();
let global: Bucket = { count: 0, windowStartedAt: 0 };

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Render terminates TLS at its proxy, so `req.ip` is the proxy without `trust proxy` set — which
 * would put every visitor in one bucket and lock out the world after five submissions. Reading
 * the forwarded header here keeps that fix local to this endpoint rather than changing `req.ip`
 * semantics app-wide.
 *
 * The header is attacker-controlled if anything but the platform proxy can reach the app. On
 * Render it cannot, and the downside of a spoofed value is a bypass of a courtesy limit, not
 * access to anything.
 */
export function resolveClientIp(headers: Record<string, string | string[] | undefined>, socketAddress?: string): string {
  const forwarded = headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = raw?.split(',')[0]?.trim();
  return first || socketAddress || 'unknown';
}

export interface RateLimitDecision {
  allowed: boolean;
  reason?: 'per_ip' | 'global';
  retryAfterSeconds: number;
}

function rollWindow(bucket: Bucket, now: number): Bucket {
  if (now - bucket.windowStartedAt >= WINDOW_MS) {
    return { count: 0, windowStartedAt: now };
  }
  return bucket;
}

function retryAfter(bucket: Bucket, now: number): number {
  return Math.max(1, Math.ceil((bucket.windowStartedAt + WINDOW_MS - now) / 1000));
}

/**
 * Counts the attempt when it is allowed. A rejected attempt does not extend the window, so an
 * impatient retry cannot push the caller's own unlock further away.
 */
export function checkDownloadRequestRateLimit(ip: string, now: number = Date.now()): RateLimitDecision {
  const maxPerIp = readPositiveInt('PORTA_DOWNLOAD_REQUEST_MAX_PER_IP_PER_HOUR', DEFAULT_MAX_PER_IP_PER_HOUR);
  const maxGlobal = readPositiveInt('PORTA_DOWNLOAD_REQUEST_MAX_PER_HOUR', DEFAULT_MAX_PER_HOUR);

  const ipBucket = rollWindow(perIp.get(ip) ?? { count: 0, windowStartedAt: now }, now);
  const globalBucket = rollWindow(global, now);

  if (ipBucket.count >= maxPerIp) {
    perIp.set(ip, ipBucket);
    global = globalBucket;
    return { allowed: false, reason: 'per_ip', retryAfterSeconds: retryAfter(ipBucket, now) };
  }

  if (globalBucket.count >= maxGlobal) {
    perIp.set(ip, ipBucket);
    global = globalBucket;
    return { allowed: false, reason: 'global', retryAfterSeconds: retryAfter(globalBucket, now) };
  }

  perIp.set(ip, { count: ipBucket.count + 1, windowStartedAt: ipBucket.windowStartedAt || now });
  global = { count: globalBucket.count + 1, windowStartedAt: globalBucket.windowStartedAt || now };

  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * The map would otherwise grow one entry per distinct address forever. Called on each request;
 * the work is proportional to expired entries, which on this endpoint's volume is nothing.
 */
export function pruneDownloadRequestRateLimit(now: number = Date.now()): void {
  for (const [ip, bucket] of perIp) {
    if (now - bucket.windowStartedAt >= WINDOW_MS) {
      perIp.delete(ip);
    }
  }
}

export function resetDownloadRequestRateLimitForTests(): void {
  perIp.clear();
  global = { count: 0, windowStartedAt: 0 };
}
