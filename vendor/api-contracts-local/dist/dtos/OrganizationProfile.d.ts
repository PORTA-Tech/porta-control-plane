export interface OrganizationProfile {
    orgId: string;
    orgName: string;
    orgSlug?: string | null;
    planTier: string;
    billingAccountId?: string | null;
    createdAt: string;
    updatedAt: string;
}
