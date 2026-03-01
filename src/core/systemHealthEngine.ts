import { listAgentPresence } from '../store/agentPresenceStore.js';

type ReliabilityVerdict = 'HEALTHY' | 'DEGRADED' | 'UNRELIABLE' | 'INCONCLUSIVE';
type TriggerSeverity = 'warning' | 'critical';
type StreamState = 'CONNECTED' | 'STALE' | 'DISCONNECTED';

type Primitive = string | number | boolean | null;

interface ApiRequestSample {
  timestamp_ms: number;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
}

interface UiMetricSample {
  timestamp_ms: number;
  render_latency_ms_p95: number | null;
  chart_render_failures: number | null;
  refresh_total: number | null;
  refresh_failed: number | null;
  last_refresh_duration_ms: number | null;
  data_coverage_pct: number | null;
  memory_usage_mb: number | null;
}

interface StreamTransition {
  timestamp_ms: number;
  type: 'drop' | 'reconnect';
}

interface StreamAgeSample {
  timestamp_ms: number;
  age_seconds: number | null;
}

interface TriggerView {
  reason_code: string;
  severity: TriggerSeverity;
  summary: string;
  details: Record<string, Primitive>;
}

interface SeriesPoint {
  timestamp_utc: string;
  value: number | null;
}

export interface SystemHealthView {
  evaluated_at_utc: string;
  verdict: {
    status: ReliabilityVerdict;
    reason_code: string;
    reason_message: string;
    trigger_count: number;
    last_successful_update_utc: string | null;
    last_successful_update_age_seconds: number | null;
  };
  data_quality: {
    coverage_pct: number;
    freshness_seconds: number | null;
    ws_stream_ok: boolean;
    metrics_available: boolean;
    min_required_reporting_machines: number;
    min_required_coverage_pct: number;
    source: 'authoritative' | 'fallback';
    messages: string[];
  };
  stream_metrics: {
    connection_state: StreamState;
    realtime_enabled: boolean;
    drops_last_1m: number;
    drops_last_15m: number;
    drops_last_1h: number;
    reconnect_attempts_last_1h: number;
    last_message_utc: string | null;
    last_message_age_seconds: number | null;
    subscriptions: {
      console_state: boolean;
      node_snapshots: boolean;
    };
    source: 'authoritative' | 'fallback';
  };
  api_metrics: {
    reachable: boolean;
    total_requests_last_15m: number;
    failed_requests_last_15m: number;
    error_rate_pct: number | null;
    status_4xx_rate_pct: number | null;
    status_5xx_rate_pct: number | null;
    latency_ms: {
      p50: number | null;
      p95: number | null;
      p99: number | null;
    };
    last_success_utc: string | null;
    source: 'authoritative' | 'fallback';
  };
  ui_metrics: {
    render_latency_ms_p95: number | null;
    chart_render_failures: number | null;
    frame_drop_pct: number | null;
    memory_usage_mb: number | null;
    placeholder_detected: boolean | null;
    source: 'authoritative' | 'fallback';
    reason_code?: string;
  };
  refresh_metrics: {
    refresh_total: number | null;
    refresh_failed: number | null;
    failed_rate_pct: number | null;
    last_refresh_duration_ms: number | null;
    data_coverage_pct: number | null;
    placeholder_detection_status: 'CLEAR' | 'DETECTED' | 'UNKNOWN';
    source: 'authoritative' | 'fallback';
  };
  needs_attention: Array<{
    id: string;
    panel: 'stream' | 'api' | 'ui' | 'refresh';
    severity: TriggerSeverity;
    title: string;
    detail: string;
    reason_code: string;
  }>;
  triggers: TriggerView[];
  series: {
    stream_drops_per_minute: SeriesPoint[];
    message_age_seconds: SeriesPoint[];
    api_latency_p95_ms: SeriesPoint[];
    api_error_rate_pct: SeriesPoint[];
    refresh_failures_per_minute: SeriesPoint[];
    coverage_pct: SeriesPoint[];
    ui_render_latency_p95_ms: SeriesPoint[];
  };
}

const API_WINDOW_MS = 15 * 60 * 1000;
const SERIES_WINDOW_MS = 60 * 60 * 1000;
const UI_WINDOW_MS = 15 * 60 * 1000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const apiSamples: ApiRequestSample[] = [];
const uiSamples: UiMetricSample[] = [];
const streamTransitions: StreamTransition[] = [];
const streamAgeSamples: StreamAgeSample[] = [];
let lastStreamState: StreamState | null = null;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.trunc(parsed)) : fallback;
}

function parseNonNegative(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (typeof raw !== 'string') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return fallback;
}

function staleHeartbeatSeconds(): number {
  return parsePositiveInt(process.env.NODE_STALE_HEARTBEAT_SECONDS, 30);
}

function realtimeEnabled(): boolean {
  return parseBoolean(process.env.CONTROL_PLANE_REALTIME_STREAM_ENABLED, false);
}

function minReportingMachines(): number {
  return parsePositiveInt(process.env.SYSTEM_HEALTH_MIN_REPORTING_MACHINES, 20);
}

function minCoveragePct(): number {
  return Math.min(100, Math.max(1, parseNonNegative(process.env.SYSTEM_HEALTH_MIN_COVERAGE_PCT, 70)));
}

function latencyP95ThresholdMs(): number {
  return parsePositiveInt(process.env.SYSTEM_HEALTH_API_P95_THRESHOLD_MS, 300);
}

function maxAllowedErrorRatePct(): number {
  return parseNonNegative(process.env.SYSTEM_HEALTH_ERROR_RATE_PCT_THRESHOLD, 5);
}

function maxAllowedFailedRefreshPct(): number {
  return parseNonNegative(process.env.SYSTEM_HEALTH_REFRESH_FAILED_PCT_THRESHOLD, 30);
}

function criticalMessageAgeSeconds(): number {
  return parsePositiveInt(process.env.SYSTEM_HEALTH_MESSAGE_AGE_CRITICAL_SECONDS, 120);
}

function warningMessageAgeSeconds(): number {
  return parsePositiveInt(process.env.SYSTEM_HEALTH_MESSAGE_AGE_WARNING_SECONDS, 30);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function percentile(values: number[], pct: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  const selected = sorted[idx];
  return selected === undefined ? null : selected;
}

function pruneByTime<T extends { timestamp_ms: number }>(items: T[], minMs: number): void {
  let removeCount = 0;
  while (removeCount < items.length) {
    const current = items[removeCount];
    if (!current || current.timestamp_ms >= minMs) break;
    removeCount += 1;
  }
  if (removeCount > 0) items.splice(0, removeCount);
}

function minuteBuckets(nowMs: number, windowMs = SERIES_WINDOW_MS): number[] {
  const endMinute = Math.floor(nowMs / 60_000) * 60_000;
  const startMinute = endMinute - windowMs + 60_000;
  const buckets: number[] = [];
  for (let cursor = startMinute; cursor <= endMinute; cursor += 60_000) {
    buckets.push(cursor);
  }
  return buckets;
}

function buildMinuteCountSeries(
  nowMs: number,
  events: Array<{ timestamp_ms: number }>,
  filterFn?: (event: { timestamp_ms: number }) => boolean
): SeriesPoint[] {
  const buckets = minuteBuckets(nowMs);
  const map = new Map<number, number>();
  for (const bucket of buckets) map.set(bucket, 0);

  for (const event of events) {
    if (event.timestamp_ms < buckets[0]! || event.timestamp_ms > buckets[buckets.length - 1]! + 59_999) continue;
    if (filterFn && !filterFn(event)) continue;
    const bucket = Math.floor(event.timestamp_ms / 60_000) * 60_000;
    map.set(bucket, (map.get(bucket) ?? 0) + 1);
  }

  return buckets.map((bucket) => ({
    timestamp_utc: toIso(bucket),
    value: map.get(bucket) ?? 0
  }));
}

function buildMinuteAvgSeries(
  nowMs: number,
  samples: Array<{ timestamp_ms: number; value: number | null }>
): SeriesPoint[] {
  const buckets = minuteBuckets(nowMs);
  const totals = new Map<number, { sum: number; count: number }>();
  for (const bucket of buckets) totals.set(bucket, { sum: 0, count: 0 });

  for (const sample of samples) {
    if (sample.timestamp_ms < buckets[0]! || sample.timestamp_ms > buckets[buckets.length - 1]! + 59_999) continue;
    if (sample.value === null || !Number.isFinite(sample.value)) continue;
    const bucket = Math.floor(sample.timestamp_ms / 60_000) * 60_000;
    const entry = totals.get(bucket);
    if (!entry) continue;
    entry.sum += sample.value;
    entry.count += 1;
  }

  return buckets.map((bucket) => {
    const entry = totals.get(bucket);
    if (!entry || entry.count === 0) {
      return { timestamp_utc: toIso(bucket), value: null };
    }
    return { timestamp_utc: toIso(bucket), value: round(entry.sum / entry.count, 3) };
  });
}

function parseUiNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function recordSystemApiRequest(input: {
  method: string;
  path: string;
  status: number;
  duration_ms: number;
}): void {
  const timestamp = Date.now();
  apiSamples.push({
    timestamp_ms: timestamp,
    method: input.method,
    path: input.path,
    status: input.status,
    duration_ms: clamp(Math.round(input.duration_ms * 1000) / 1000, 0, 60_000)
  });
  pruneByTime(apiSamples, timestamp - MAX_AGE_MS);
}

export function recordSystemUiHealthSample(payload: Record<string, unknown>): void {
  const nowMs = Date.now();
  const sampledAt = typeof payload.sampled_at_utc === 'string' ? Date.parse(payload.sampled_at_utc) : Number.NaN;
  const timestampMs = Number.isFinite(sampledAt) ? sampledAt : nowMs;
  uiSamples.push({
    timestamp_ms: timestampMs,
    render_latency_ms_p95: parseUiNumber(payload.render_latency_ms_p95),
    chart_render_failures: parseUiNumber(payload.chart_render_failures),
    refresh_total: parseUiNumber(payload.refresh_total),
    refresh_failed: parseUiNumber(payload.refresh_failed),
    last_refresh_duration_ms: parseUiNumber(payload.last_refresh_duration_ms),
    data_coverage_pct: parseUiNumber(payload.data_coverage_pct),
    memory_usage_mb: parseUiNumber(payload.memory_usage_mb)
  });
  pruneByTime(uiSamples, nowMs - MAX_AGE_MS);
}

function deriveStreamState(nowMs: number): {
  state: StreamState;
  latestHeartbeatUtc: string | null;
  latestAgeSeconds: number | null;
  coveragePct: number;
  reportingMachines: number;
} {
  const presences = listAgentPresence();
  const latestHeartbeatMs = presences.reduce<number | null>((latest, row) => {
    const parsed = Date.parse(row.lastHeartbeatUtc);
    if (!Number.isFinite(parsed)) return latest;
    if (latest === null || parsed > latest) return parsed;
    return latest;
  }, null);

  const reportingMachines = presences.length;
  const coverage = round((reportingMachines / minReportingMachines()) * 100, 2);

  if (latestHeartbeatMs === null) {
    return {
      state: 'DISCONNECTED',
      latestHeartbeatUtc: null,
      latestAgeSeconds: null,
      coveragePct: coverage,
      reportingMachines
    };
  }

  const ageSeconds = Math.max(0, Math.round((nowMs - latestHeartbeatMs) / 1000));
  const state: StreamState = ageSeconds <= staleHeartbeatSeconds() * 2 ? 'CONNECTED' : 'STALE';
  return {
    state,
    latestHeartbeatUtc: new Date(latestHeartbeatMs).toISOString(),
    latestAgeSeconds: ageSeconds,
    coveragePct: coverage,
    reportingMachines
  };
}

function updateStreamTransitions(nowMs: number, currentState: StreamState, ageSeconds: number | null): void {
  if (lastStreamState && lastStreamState !== currentState) {
    if (lastStreamState === 'CONNECTED' && (currentState === 'STALE' || currentState === 'DISCONNECTED')) {
      streamTransitions.push({ timestamp_ms: nowMs, type: 'drop' });
    }
    if ((lastStreamState === 'STALE' || lastStreamState === 'DISCONNECTED') && currentState === 'CONNECTED') {
      streamTransitions.push({ timestamp_ms: nowMs, type: 'reconnect' });
    }
  }
  lastStreamState = currentState;
  streamAgeSamples.push({ timestamp_ms: nowMs, age_seconds: ageSeconds });
  pruneByTime(streamTransitions, nowMs - MAX_AGE_MS);
  pruneByTime(streamAgeSamples, nowMs - MAX_AGE_MS);
}

function countTransitions(nowMs: number, type: StreamTransition['type'], windowMs: number): number {
  return streamTransitions.filter((row) => row.type === type && row.timestamp_ms >= nowMs - windowMs).length;
}

function toNeedsAttention(trigger: TriggerView): {
  id: string;
  panel: 'stream' | 'api' | 'ui' | 'refresh';
  severity: TriggerSeverity;
  title: string;
  detail: string;
  reason_code: string;
} {
  const panel: 'stream' | 'api' | 'ui' | 'refresh' =
    trigger.reason_code.startsWith('STREAM_') ? 'stream'
      : trigger.reason_code.startsWith('API_') ? 'api'
        : trigger.reason_code.startsWith('UI_') || trigger.reason_code === 'METRICS_PLACEHOLDER_DETECTED' ? 'ui'
          : 'refresh';
  return {
    id: trigger.reason_code.toLowerCase(),
    panel,
    severity: trigger.severity,
    title: trigger.summary,
    detail: Object.entries(trigger.details).map(([k, v]) => `${k}: ${String(v)}`).join(' | '),
    reason_code: trigger.reason_code
  };
}

export function evaluateSystemHealth(): SystemHealthView {
  const nowMs = Date.now();
  const nowUtc = new Date(nowMs).toISOString();
  const realtime = realtimeEnabled();

  const stream = deriveStreamState(nowMs);
  updateStreamTransitions(nowMs, stream.state, stream.latestAgeSeconds);

  const apiWindow = apiSamples.filter((row) => row.timestamp_ms >= nowMs - API_WINDOW_MS && !row.path.startsWith('/v1/system/'));
  const apiLatencies = apiWindow.filter((row) => row.status >= 200 && row.status < 500).map((row) => row.duration_ms);
  const api4xx = apiWindow.filter((row) => row.status >= 400 && row.status < 500).length;
  const api5xx = apiWindow.filter((row) => row.status >= 500).length;
  const apiFailures = api4xx + api5xx;
  const apiTotal = apiWindow.length;
  const errorRatePct = apiTotal > 0 ? round((apiFailures / apiTotal) * 100, 3) : null;
  const error4xxRatePct = apiTotal > 0 ? round((api4xx / apiTotal) * 100, 3) : null;
  const error5xxRatePct = apiTotal > 0 ? round((api5xx / apiTotal) * 100, 3) : null;
  const lastSuccessMs = apiWindow
    .filter((row) => row.status >= 200 && row.status < 500)
    .reduce<number | null>((latest, row) => (latest === null || row.timestamp_ms > latest ? row.timestamp_ms : latest), null);
  const lastSuccessUtc = lastSuccessMs ? new Date(lastSuccessMs).toISOString() : null;
  const lastSuccessAgeSec = lastSuccessMs ? Math.max(0, Math.round((nowMs - lastSuccessMs) / 1000)) : null;
  const apiReachable = lastSuccessMs !== null && nowMs - lastSuccessMs <= 120_000;

  const uiWindow = uiSamples.filter((row) => row.timestamp_ms >= nowMs - UI_WINDOW_MS);
  const uiRenderValues = uiWindow
    .map((row) => row.render_latency_ms_p95)
    .filter((row): row is number => row !== null && Number.isFinite(row));
  const latestUi = uiSamples.at(-1);
  const renderP95 = percentile(uiRenderValues, 95);
  const recentZeroLatency = uiWindow
    .map((row) => row.render_latency_ms_p95)
    .filter((row): row is number => row !== null && Number.isFinite(row));
  const placeholderDetected = recentZeroLatency.length >= 3 && recentZeroLatency.every((row) => row === 0);

  const refreshTotal = latestUi?.refresh_total ?? null;
  const refreshFailed = latestUi?.refresh_failed ?? null;
  const refreshFailedRatePct = refreshTotal !== null && refreshFailed !== null && refreshTotal > 0
    ? round((refreshFailed / refreshTotal) * 100, 3)
    : null;

  const triggers: TriggerView[] = [];
  if (!realtime) {
    triggers.push({
      reason_code: 'STREAM_DISABLED',
      severity: 'warning',
      summary: 'Realtime channel is disabled. System health is sampled.',
      details: { realtime_enabled: false }
    });
  }

  if (stream.state === 'DISCONNECTED' || (stream.latestAgeSeconds !== null && stream.latestAgeSeconds > criticalMessageAgeSeconds())) {
    triggers.push({
      reason_code: 'STREAM_DISCONNECTED',
      severity: 'critical',
      summary: 'Stream is disconnected or stale beyond critical age.',
      details: {
        connection_state: stream.state,
        last_message_age_seconds: stream.latestAgeSeconds
      }
    });
  } else if (stream.state === 'STALE' || (stream.latestAgeSeconds !== null && stream.latestAgeSeconds > warningMessageAgeSeconds())) {
    triggers.push({
      reason_code: 'STREAM_STALE',
      severity: 'warning',
      summary: 'Stream freshness is stale.',
      details: {
        connection_state: stream.state,
        last_message_age_seconds: stream.latestAgeSeconds
      }
    });
  }

  const p95Latency = percentile(apiLatencies, 95);
  if (!apiReachable) {
    triggers.push({
      reason_code: 'API_UNREACHABLE',
      severity: 'critical',
      summary: 'Control-plane API is not reachable within freshness window.',
      details: { last_success_age_seconds: lastSuccessAgeSec }
    });
  } else if (p95Latency !== null && p95Latency > latencyP95ThresholdMs()) {
    triggers.push({
      reason_code: 'API_LATENCY_HIGH',
      severity: 'warning',
      summary: 'API latency is above threshold.',
      details: { p95_latency_ms: round(p95Latency, 2), threshold_ms: latencyP95ThresholdMs() }
    });
  }

  if (errorRatePct !== null && errorRatePct > maxAllowedErrorRatePct()) {
    triggers.push({
      reason_code: 'API_ERROR_RATE_HIGH',
      severity: errorRatePct > Math.max(10, maxAllowedErrorRatePct() * 1.5) ? 'critical' : 'warning',
      summary: 'API error rate exceeds threshold.',
      details: { error_rate_pct: errorRatePct, threshold_pct: maxAllowedErrorRatePct() }
    });
  }

  if (refreshFailedRatePct !== null && refreshFailedRatePct > maxAllowedFailedRefreshPct()) {
    triggers.push({
      reason_code: 'REFRESH_FAILURES',
      severity: refreshFailedRatePct > 50 ? 'critical' : 'warning',
      summary: 'Refresh failure rate is too high.',
      details: {
        refresh_failed_rate_pct: refreshFailedRatePct,
        threshold_pct: maxAllowedFailedRefreshPct()
      }
    });
  }

  if (placeholderDetected) {
    triggers.push({
      reason_code: 'METRICS_PLACEHOLDER_DETECTED',
      severity: 'warning',
      summary: 'UI metrics appear to be placeholder values.',
      details: { render_latency_samples: recentZeroLatency.length, value: 0 }
    });
  }

  if (stream.reportingMachines < minReportingMachines() || stream.coveragePct < minCoveragePct()) {
    triggers.push({
      reason_code: 'INSUFFICIENT_COVERAGE',
      severity: 'warning',
      summary: 'Reporting machine coverage is below minimum.',
      details: {
        reporting_machines: stream.reportingMachines,
        min_required_machines: minReportingMachines(),
        coverage_pct: stream.coveragePct,
        min_coverage_pct: minCoveragePct()
      }
    });
  }

  if (apiTotal === 0 && uiWindow.length === 0 && stream.reportingMachines === 0) {
    triggers.push({
      reason_code: 'NO_DATA',
      severity: 'warning',
      summary: 'No reliability telemetry is available.',
      details: {}
    });
  }

  let verdict: ReliabilityVerdict = 'HEALTHY';
  if (triggers.some((trigger) => trigger.reason_code === 'NO_DATA')) {
    verdict = 'INCONCLUSIVE';
  } else if (triggers.some((trigger) => trigger.severity === 'critical')) {
    verdict = 'UNRELIABLE';
  } else if (triggers.length > 0) {
    verdict = 'DEGRADED';
  }

  const topReason = triggers[0] ?? {
    reason_code: 'ALL_HEALTH_CHECKS_PASS',
    severity: 'warning',
    summary: 'Console and pipeline reliability checks are healthy.',
    details: {}
  };

  const streamDropSeries = buildMinuteCountSeries(
    nowMs,
    streamTransitions.filter((row) => row.type === 'drop')
  );
  const messageAgeSeries = buildMinuteAvgSeries(
    nowMs,
    streamAgeSamples.map((row) => ({ timestamp_ms: row.timestamp_ms, value: row.age_seconds }))
  );
  const apiLatencySeries = buildMinuteAvgSeries(
    nowMs,
    apiSamples.map((row) => ({
      timestamp_ms: row.timestamp_ms,
      value: row.status >= 200 && row.status < 500 ? row.duration_ms : null
    }))
  );
  const apiErrorSeries = buildMinuteAvgSeries(
    nowMs,
    apiSamples.map((row) => ({
      timestamp_ms: row.timestamp_ms,
      value: row.status >= 400 ? 100 : 0
    }))
  );
  const refreshFailureSeries = buildMinuteAvgSeries(
    nowMs,
    uiSamples.map((row) => {
      const value = row.refresh_total && row.refresh_total > 0 && row.refresh_failed !== null
        ? (row.refresh_failed / row.refresh_total) * 100
        : null;
      return { timestamp_ms: row.timestamp_ms, value };
    })
  );
  const coverageSeries = buildMinuteAvgSeries(
    nowMs,
    uiSamples.map((row) => ({
      timestamp_ms: row.timestamp_ms,
      value: row.data_coverage_pct
    }))
  );
  const uiRenderSeries = buildMinuteAvgSeries(
    nowMs,
    uiSamples.map((row) => ({
      timestamp_ms: row.timestamp_ms,
      value: row.render_latency_ms_p95
    }))
  );

  const dataQualityMessages: string[] = [];
  if (stream.reportingMachines < minReportingMachines()) dataQualityMessages.push('Not enough reporting machines.');
  if (stream.coveragePct < minCoveragePct()) dataQualityMessages.push('Coverage below minimum threshold.');
  if (stream.latestAgeSeconds !== null && stream.latestAgeSeconds > warningMessageAgeSeconds()) dataQualityMessages.push('Freshness stale.');
  if (!realtime) dataQualityMessages.push('Realtime channel disabled.');
  if (dataQualityMessages.length === 0) dataQualityMessages.push('Reliability telemetry checks passed.');

  return {
    evaluated_at_utc: nowUtc,
    verdict: {
      status: verdict,
      reason_code: topReason.reason_code,
      reason_message: topReason.summary,
      trigger_count: triggers.length,
      last_successful_update_utc: lastSuccessUtc,
      last_successful_update_age_seconds: lastSuccessAgeSec
    },
    data_quality: {
      coverage_pct: stream.coveragePct,
      freshness_seconds: stream.latestAgeSeconds,
      ws_stream_ok: stream.state === 'CONNECTED',
      metrics_available: apiTotal > 0 || uiWindow.length > 0 || stream.reportingMachines > 0,
      min_required_reporting_machines: minReportingMachines(),
      min_required_coverage_pct: minCoveragePct(),
      source: 'authoritative',
      messages: dataQualityMessages
    },
    stream_metrics: {
      connection_state: stream.state,
      realtime_enabled: realtime,
      drops_last_1m: countTransitions(nowMs, 'drop', 60_000),
      drops_last_15m: countTransitions(nowMs, 'drop', 15 * 60_000),
      drops_last_1h: countTransitions(nowMs, 'drop', 60 * 60_000),
      reconnect_attempts_last_1h: countTransitions(nowMs, 'reconnect', 60 * 60_000),
      last_message_utc: stream.latestHeartbeatUtc,
      last_message_age_seconds: stream.latestAgeSeconds,
      subscriptions: {
        console_state: realtime,
        node_snapshots: true
      },
      source: 'authoritative'
    },
    api_metrics: {
      reachable: apiReachable,
      total_requests_last_15m: apiTotal,
      failed_requests_last_15m: apiFailures,
      error_rate_pct: errorRatePct,
      status_4xx_rate_pct: error4xxRatePct,
      status_5xx_rate_pct: error5xxRatePct,
      latency_ms: {
        p50: percentile(apiLatencies, 50),
        p95: p95Latency,
        p99: percentile(apiLatencies, 99)
      },
      last_success_utc: lastSuccessUtc,
      source: apiTotal > 0 ? 'authoritative' : 'fallback'
    },
    ui_metrics: {
      render_latency_ms_p95: renderP95,
      chart_render_failures: latestUi?.chart_render_failures ?? null,
      frame_drop_pct: null,
      memory_usage_mb: latestUi?.memory_usage_mb ?? null,
      placeholder_detected: uiWindow.length > 0 ? placeholderDetected : null,
      source: uiWindow.length > 0 ? 'authoritative' : 'fallback',
      ...(uiWindow.length === 0 ? { reason_code: 'NO_UI_TELEMETRY' } : {})
    },
    refresh_metrics: {
      refresh_total: refreshTotal,
      refresh_failed: refreshFailed,
      failed_rate_pct: refreshFailedRatePct,
      last_refresh_duration_ms: latestUi?.last_refresh_duration_ms ?? null,
      data_coverage_pct: latestUi?.data_coverage_pct ?? stream.coveragePct,
      placeholder_detection_status: placeholderDetected ? 'DETECTED' : uiWindow.length === 0 ? 'UNKNOWN' : 'CLEAR',
      source: uiWindow.length > 0 ? 'authoritative' : 'fallback'
    },
    needs_attention: triggers.map(toNeedsAttention),
    triggers,
    series: {
      stream_drops_per_minute: streamDropSeries,
      message_age_seconds: messageAgeSeries,
      api_latency_p95_ms: apiLatencySeries,
      api_error_rate_pct: apiErrorSeries,
      refresh_failures_per_minute: refreshFailureSeries,
      coverage_pct: coverageSeries,
      ui_render_latency_p95_ms: uiRenderSeries
    }
  };
}
