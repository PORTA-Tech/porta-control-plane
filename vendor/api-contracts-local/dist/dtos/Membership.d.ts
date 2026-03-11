export type MembershipRole = 'owner' | 'admin' | 'member' | 'viewer';
export type MembershipStatus = 'invited' | 'active' | 'suspended' | 'revoked';
export interface Membership {
    membershipId: string;
    accountId: string;
    orgId: string;
    role: MembershipRole;
    status: MembershipStatus;
    invitedAt?: string | null;
    joinedAt?: string | null;
    invitedByAccountId?: string | null;
    createdAt: string;
    updatedAt: string;
}
