export interface DeviceRegistrationRequest {
    deviceId: string;
    machineName: string;
    deviceDisplayName?: string | null;
    platform: string;
    agentVersion: string;
    accountId?: string | null;
    orgId?: string | null;
    sessionToken?: string | null;
    localProofToken?: string | null;
}
