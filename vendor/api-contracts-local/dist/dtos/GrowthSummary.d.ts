export interface GrowthSummary {
    timezone: string;
    generatedAtUtc: string;
    windowStartUtc: string;
    windowEndUtc: string;
    totalRegisteredUsers: number;
    newRegisteredUsers: number;
    activatedUsers: number;
    activationRatePct: number | null;
    retentionRateD1Pct: number | null;
    retentionRateD7Pct: number | null;
    retentionRateD30Pct: number | null;
    churnRateD1Pct: number | null;
    churnRateD7Pct: number | null;
    churnRateD30Pct: number | null;
}
