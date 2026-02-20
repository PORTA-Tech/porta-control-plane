export interface SLOMetrics {
    windowStartUtc: string;
    windowEndUtc: string;
    cohortId: string;
    errorRatePct: number;
    p99LatencyMs: number;
    degradationRatePct: number;
    heartbeatGapIntervals: number;
}
