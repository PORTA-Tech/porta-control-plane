import type { ConsentState, TelemetryLevel } from './ConsentRecord.js';
export interface DeviceRegistrationRequest {
    deviceId: string;
    machineName: string;
    deviceDisplayName?: string | null;
    platform: string;
    agentVersion: string;
    accountId?: string | null;
    orgId?: string | null;
    deviceCaptureConsentState?: ConsentState | null;
    deviceCaptureConsentVersion?: string | null;
    deviceCaptureConsentedAt?: string | null;
    deviceCaptureTelemetryLevel?: TelemetryLevel | null;
    sessionToken?: string | null;
    localProofToken?: string | null;
}
