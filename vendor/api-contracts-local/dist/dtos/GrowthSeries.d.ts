export type GrowthSeriesMetric = 'registrations' | 'activations' | 'active_users';
export type GrowthSeriesInterval = 'day' | 'week' | 'month';
export interface GrowthSeriesPoint {
    bucketStartUtc: string;
    bucketEndUtc: string;
    value: number;
}
export interface GrowthSeries {
    metric: GrowthSeriesMetric;
    interval: GrowthSeriesInterval;
    timezone: string;
    points: GrowthSeriesPoint[];
}
