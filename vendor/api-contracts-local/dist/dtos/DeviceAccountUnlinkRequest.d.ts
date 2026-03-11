export interface DeviceAccountUnlinkRequest {
    deviceId: string;
    accountId?: string | null;
    orgId?: string | null;
    sessionToken?: string | null;
    localProofToken?: string | null;
}
