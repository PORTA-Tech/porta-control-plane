import type { AccountProfile, ConsentRecord, DeviceProfile, Membership, OrganizationProfile } from '@porta/api-contracts';
import { getAccountProfile, getAccountProfileByPrimaryEmail, listAccountProfiles, upsertAccountProfile } from '../store/accountStore.js';
import { getOrganizationProfile, listOrganizationProfiles } from '../store/organizationStore.js';
import { getDeviceProfile, listDeviceProfilesForAccount, listDeviceProfilesForOrganization, upsertDeviceProfile } from '../store/deviceStore.js';
import { listMembershipsForAccount, listMembershipsForOrganization } from '../store/membershipStore.js';
import { listConsentRecordsForAccount, listConsentRecordsForOrganization } from '../store/consentRecordStore.js';
import { readAuthUserIdentity } from './authSessionStore.js';

export interface AccountMembershipView {
  membership: Membership;
  organization: OrganizationProfile | null;
}

export interface MeProfileView {
  account: AccountProfile;
  organizations: AccountMembershipView[];
  devices: DeviceProfile[];
}

export interface AdminAccountView {
  account: AccountProfile;
  memberships: AccountMembershipView[];
  devices: DeviceProfile[];
  consents: ConsentRecord[];
}

export interface OrganizationMembershipView {
  membership: Membership;
  account: AccountProfile | null;
}

export interface AdminOrganizationView {
  organization: OrganizationProfile;
  memberships: OrganizationMembershipView[];
  devices: DeviceProfile[];
  consents: ConsentRecord[];
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function ensureAccountProfileForAuthUser(userId: string): Promise<AccountProfile | null> {
  const authUser = readAuthUserIdentity(userId);
  if (!authUser) {
    return null;
  }

  const existingById = await getAccountProfile(authUser.account_id);
  const existingByEmail = existingById ? null : await getAccountProfileByPrimaryEmail(authUser.user_id);
  const existing = existingById ?? existingByEmail;
  const timestamp = nowIso();

  const profile: AccountProfile = {
    accountId: existing?.accountId ?? authUser.account_id,
    displayName: authUser.display_name,
    primaryEmail: authUser.user_id,
    emailVerified: existing?.emailVerified ?? false,
    avatarUrl: authUser.avatar_url ?? existing?.avatarUrl ?? null,
    status: existing?.status ?? 'active',
    authProvider: authUser.auth_provider ?? existing?.authProvider ?? 'local',
    lastLoginAt: existing?.lastLoginAt ?? null,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp
  };

  await upsertAccountProfile(profile);
  return profile;
}

export async function listAccountMembershipViews(accountId: string): Promise<AccountMembershipView[]> {
  const memberships = await listMembershipsForAccount(accountId);
  return Promise.all(
    memberships.map(async (membership) => ({
      membership,
      organization: await getOrganizationProfile(membership.orgId)
    }))
  );
}

export async function buildMeProfileView(userId: string): Promise<MeProfileView | null> {
  const account = await ensureAccountProfileForAuthUser(userId);
  if (!account) {
    return null;
  }

  const organizations = await listAccountMembershipViews(account.accountId);
  const devices = await listDeviceProfilesForAccount(account.accountId);

  return {
    account,
    organizations,
    devices
  };
}

export async function revokeDeviceForAccount(accountId: string, deviceId: string): Promise<DeviceProfile | null> {
  const current = await getDeviceProfile(deviceId);
  if (!current || current.currentAccountId !== accountId) {
    return null;
  }

  const updated: DeviceProfile = {
    ...current,
    status: 'revoked',
    revokedAt: current.revokedAt ?? nowIso(),
    updatedAt: nowIso()
  };

  await upsertDeviceProfile(updated);
  return updated;
}

export async function buildAdminAccountView(accountId: string): Promise<AdminAccountView | null> {
  const account = await getAccountProfile(accountId);
  if (!account) {
    return null;
  }

  return {
    account,
    memberships: await listAccountMembershipViews(accountId),
    devices: await listDeviceProfilesForAccount(accountId),
    consents: await listConsentRecordsForAccount(accountId)
  };
}

export async function buildAdminOrganizationView(orgId: string): Promise<AdminOrganizationView | null> {
  const organization = await getOrganizationProfile(orgId);
  if (!organization) {
    return null;
  }

  const memberships = await listMembershipsForOrganization(orgId);
  const accounts = await listAccountProfiles();
  const accountById = new Map(accounts.map((account) => [account.accountId, account]));

  return {
    organization,
    memberships: memberships.map((membership) => ({
      membership,
      account: accountById.get(membership.accountId) ?? null
    })),
    devices: await listDeviceProfilesForOrganization(orgId),
    consents: await listConsentRecordsForOrganization(orgId)
  };
}

export async function listOrganizationsForAuthUser(userId: string): Promise<AccountMembershipView[] | null> {
  const account = await ensureAccountProfileForAuthUser(userId);
  if (!account) {
    return null;
  }
  return listAccountMembershipViews(account.accountId);
}

export async function listDevicesForAuthUser(userId: string): Promise<DeviceProfile[] | null> {
  const account = await ensureAccountProfileForAuthUser(userId);
  if (!account) {
    return null;
  }
  return listDeviceProfilesForAccount(account.accountId);
}
