export type GrowthUserSource = 'default' | 'env' | 'custom';
export type GrowthUserJourneyEventType = 'account_registered' | 'membership_joined' | 'device_linked' | 'device_capture_consented' | 'account_activated' | 'account_active_day';
export interface GrowthUserJourneyEvent {
    eventType: GrowthUserJourneyEventType;
    occurredAtUtc: string;
    activityDate?: string | null;
    deviceId?: string | null;
    orgId?: string | null;
    machineId?: string | null;
    metadata?: Record<string, string | number | boolean | null>;
}
export interface GrowthUserJourney {
    accountId: string;
    userId: string;
    source: GrowthUserSource;
    registrationAtUtc?: string | null;
    activationAtUtc?: string | null;
    events: GrowthUserJourneyEvent[];
    activeDays: string[];
}
