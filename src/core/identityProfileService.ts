import type {
  AccountProfile,
  ConsentRecord,
  DeviceAccountLinkRequest,
  DeviceAccountUnlinkRequest,
  DeviceLinkResult,
  DeviceProfile,
  DeviceRegistrationRequest,
  Membership,
  OrganizationProfile
} from '@porta/api-contracts';
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

export interface IdentityOperationError {
  status: number;
  errorCode: string;
  message: string;
}

export type DeviceIdentityOperationResult =
  | { ok: true; value: DeviceLinkResult }
  | { ok: false; error: IdentityOperationError };

function nowIso(): string {
  return new Date().toISOString();
}

function linkedState(device: DeviceProfile): 'linked' | 'unlinked' {
  return device.currentAccountId ? 'linked' : 'unlinked';
}

function success(device: DeviceProfile): DeviceIdentityOperationResult {
  return {
    ok: true,
    value: {
      ok: true,
      linkState: linkedState(device),
      device
    }
  };
}

function failure(status: number, errorCode: string, message: string): DeviceIdentityOperationResult {
  return {
    ok: false,
    error: {
      status,
      errorCode,
      message
    }
  };
}

async function hasActiveMembership(accountId: string, orgId: string): Promise<boolean> {
  const memberships = await listMembershipsForAccount(accountId);
  return memberships.some((membership) => membership.orgId === orgId && membership.status === 'active');
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

export async function registerDeviceIdentity(request: DeviceRegistrationRequest): Promise<DeviceIdentityOperationResult> {
  const existing = await getDeviceProfile(request.deviceId);

  if (request.accountId) {
    const account = await getAccountProfile(request.accountId);
    if (!account) {
      return failure(404, 'ACCOUNT_NOT_FOUND', 'Account profile was not found.');
    }
  }

  if (request.orgId) {
    const organization = await getOrganizationProfile(request.orgId);
    if (!organization) {
      return failure(404, 'ORGANIZATION_NOT_FOUND', 'Organization profile was not found.');
    }
  }

  if (request.accountId && request.orgId) {
    const membershipActive = await hasActiveMembership(request.accountId, request.orgId);
    if (!membershipActive) {
      return failure(409, 'MEMBERSHIP_NOT_ACTIVE', 'Account is not actively linked to the organization.');
    }
  }

  const timestamp = nowIso();
  const profile: DeviceProfile = {
    deviceId: request.deviceId,
    orgId: request.orgId ?? existing?.orgId ?? null,
    machineName: request.machineName,
    deviceDisplayName: request.deviceDisplayName ?? existing?.deviceDisplayName ?? request.machineName,
    platform: request.platform,
    agentVersion: request.agentVersion,
    status: existing?.status ?? 'active',
    firstSeenAt: existing?.firstSeenAt ?? timestamp,
    lastSeenAt: timestamp,
    currentAccountId: request.accountId ?? existing?.currentAccountId ?? null,
    revokedAt: existing?.revokedAt ?? null,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp
  };

  await upsertDeviceProfile(profile);
  return success(profile);
}

export async function linkDeviceIdentity(request: DeviceAccountLinkRequest): Promise<DeviceIdentityOperationResult> {
  const device = await getDeviceProfile(request.deviceId);
  if (!device) {
    return failure(404, 'DEVICE_NOT_FOUND', 'Device profile was not found.');
  }

  if (device.status === 'revoked') {
    return failure(409, 'DEVICE_REVOKED', 'Revoked devices cannot be linked to an account.');
  }

  const account = await getAccountProfile(request.accountId);
  if (!account) {
    return failure(404, 'ACCOUNT_NOT_FOUND', 'Account profile was not found.');
  }

  const organization = await getOrganizationProfile(request.orgId);
  if (!organization) {
    return failure(404, 'ORGANIZATION_NOT_FOUND', 'Organization profile was not found.');
  }

  const membershipActive = await hasActiveMembership(request.accountId, request.orgId);
  if (!membershipActive) {
    return failure(409, 'MEMBERSHIP_NOT_ACTIVE', 'Account is not actively linked to the organization.');
  }

  const timestamp = nowIso();
  const updated: DeviceProfile = {
    ...device,
    orgId: request.orgId,
    currentAccountId: request.accountId,
    lastSeenAt: timestamp,
    updatedAt: timestamp
  };

  await upsertDeviceProfile(updated);
  return success(updated);
}

export async function unlinkDeviceIdentity(request: DeviceAccountUnlinkRequest): Promise<DeviceIdentityOperationResult> {
  const device = await getDeviceProfile(request.deviceId);
  if (!device) {
    return failure(404, 'DEVICE_NOT_FOUND', 'Device profile was not found.');
  }

  if (request.accountId && device.currentAccountId !== request.accountId) {
    return failure(409, 'DEVICE_LINK_MISMATCH', 'Device is not linked to the requested account.');
  }

  if (request.orgId && device.orgId !== request.orgId) {
    return failure(409, 'DEVICE_LINK_MISMATCH', 'Device is not linked to the requested organization.');
  }

  const timestamp = nowIso();
  const updated: DeviceProfile = {
    ...device,
    currentAccountId: null,
    lastSeenAt: timestamp,
    updatedAt: timestamp
  };

  await upsertDeviceProfile(updated);
  return success(updated);
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
