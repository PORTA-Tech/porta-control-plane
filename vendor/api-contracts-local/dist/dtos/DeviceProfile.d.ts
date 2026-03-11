export type DeviceStatus = 'active' | 'revoked';
export interface DeviceProfile {
    deviceId: string;
    orgId?: string | null;
    machineName: string;
    deviceDisplayName: string;
    platform: string;
    agentVersion: string;
    status: DeviceStatus;
    firstSeenAt: string;
    lastSeenAt: string;
    currentAccountId?: string | null;
    revokedAt?: string | null;
    createdAt: string;
    updatedAt: string;
}
