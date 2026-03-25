export interface GrowthCohortWindow {
    day: number;
    eligibleUsers: number;
    retainedUsers: number;
    retentionRatePct: number | null;
    churnedUsers: number;
    churnRatePct: number | null;
}
export interface GrowthCohortRow {
    cohortDate: string;
    registeredUsers: number;
    activatedUsers: number;
    windows: GrowthCohortWindow[];
}
export interface GrowthCohorts {
    timezone: string;
    rows: GrowthCohortRow[];
}
