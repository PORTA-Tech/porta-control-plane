export type ConsentScope = 'account_legal' | 'device_capture';
export type ConsentState = 'accepted' | 'declined' | 'revoked';
export type TelemetryLevel = 'essential' | 'enhanced';
export interface ConsentRecord {
    consentId: string;
    scope: ConsentScope;
    accountId?: string | null;
    deviceId?: string | null;
    orgId?: string | null;
    consentVersion: string;
    consentState: ConsentState;
    telemetryLevel?: TelemetryLevel | null;
    consentedAt: string;
    updatedAt: string;
}
