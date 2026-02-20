import { SLOMetrics } from '@porta/api-contracts';

export interface SLOThresholds {
  errorRatePct: number;
  p99LatencyMs: number;
  degradationRatePct: number;
  heartbeatGapIntervals: number;
}

export const defaultSLOThresholds: SLOThresholds = {
  errorRatePct: 0.5,
  p99LatencyMs: 250,
  degradationRatePct: 1.0,
  heartbeatGapIntervals: 2
};

export function isSLOBreached(metrics: SLOMetrics, thresholds: SLOThresholds = defaultSLOThresholds): boolean {
  return (
    metrics.errorRatePct > thresholds.errorRatePct ||
    metrics.p99LatencyMs > thresholds.p99LatencyMs ||
    metrics.degradationRatePct > thresholds.degradationRatePct ||
    metrics.heartbeatGapIntervals > thresholds.heartbeatGapIntervals
  );
}
