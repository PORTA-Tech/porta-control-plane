export type AccountStatus = 'active' | 'suspended' | 'deleted';
export type AuthProvider = 'local' | 'google' | 'microsoft' | 'sso';
export interface AccountProfile {
    accountId: string;
    displayName: string;
    primaryEmail: string;
    emailVerified: boolean;
    avatarUrl?: string | null;
    status: AccountStatus;
    authProvider?: AuthProvider | null;
    lastLoginAt?: string | null;
    firstName?: string | null;
    createdAt: string;
    updatedAt: string;
}
