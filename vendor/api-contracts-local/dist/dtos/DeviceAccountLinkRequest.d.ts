export interface DeviceAccountLinkRequest {
    deviceId: string;
    accountId: string;
    orgId: string;
    sessionToken?: string | null;
    localProofToken?: string | null;
}
