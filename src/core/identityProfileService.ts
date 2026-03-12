import { createHash } from 'node:crypto';
import type {
  AccountProfile,
  ConsentRecord,
  ConsentState,
  DeviceAccountLinkRequest,
  DeviceAccountUnlinkRequest,
  DeviceLinkResult,
  DeviceProfile,
  DeviceRegistrationRequest,
  Membership,
  OrganizationProfile,
  TelemetryLevel
} from '@porta/api-contracts';
import { getAccountProfile, getAccountProfileByPrimaryEmail, listAccountProfiles, upsertAccountProfile } from '../store/accountStore.js';
import { getOrganizationProfile, listOrganizationProfiles } from '../store/organizationStore.js';
import { getDeviceProfile, listDeviceProfilesForAccount, listDeviceProfilesForOrganization, upsertDeviceProfile } from '../store/deviceStore.js';
import { listMembershipsForAccount, listMembershipsForOrganization } from '../store/membershipStore.js';
import { listConsentRecordsForAccount, listConsentRecordsForOrganization, upsertConsentRecord } from '../store/consentRecordStore.js';
import { readAuthUserIdentity } from './authSessionStore.js';

export interface AccountMembershipView {
  membership: Membership;
  organization: OrganizationProfile | null;
}

export interface MeProfileView {
  account: AccountProfile;
  organizations: AccountMembershipView[];
  devices: DeviceProfile[];
  consents: ConsentRecord[];
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

const ACCOUNT_LEGAL_CONSENT_VERSION = 'v1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeOptionalUuid(value: string | null | undefined): string | null {
  const trimmed = normalizeOptionalString(value);
  return trimmed && UUID_PATTERN.test(trimmed) ? trimmed : null;
}

function normalizeTelemetryTimestamp(value: string | null | undefined): string {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return nowIso();
  }

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? nowIso() : new Date(parsed).toISOString();
}

function maxIso(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function deriveStableConsentId(scope: string, accountId: string | null, deviceId: string | null, orgId: string | null): string {
  const digest = createHash('sha256')
    .update(`porta-consent:${scope}:${accountId ?? ''}:${deviceId ?? ''}:${orgId ?? ''}`)
    .digest('hex');
  const raw = digest.slice(0, 32).split('');
  raw[12] = '4';
  const variant = Number.parseInt(raw[16] ?? '8', 16);
  raw[16] = ((variant & 0x3) | 0x8).toString(16);
  const hex = raw.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function linkedState(device: DeviceProfile): 'linked' | 'unlinked' {
  return device.currentAccountId && device.status === 'active' ? 'linked' : 'unlinked';
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

async function canBackfillLinkedDevice(accountId: string, orgId: string): Promise<boolean> {
  const [account, organization] = await Promise.all([
    getAccountProfile(accountId),
    getOrganizationProfile(orgId)
  ]);
  if (!account || !organization) {
    return false;
  }

  return hasActiveMembership(accountId, orgId);
}

function selectLatestConsentRecord(
  records: ConsentRecord[],
  scope: 'account_legal' | 'device_capture',
  deviceId: string | null,
  orgId: string | null
): ConsentRecord | null {
  const matches = records
    .filter((record) => record.scope === scope)
    .filter((record) => (record.deviceId ?? null) === deviceId)
    .filter((record) => (record.orgId ?? null) === orgId)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));

  return matches[0] ?? null;
}

async function ensureAccountLegalConsent(account: AccountProfile): Promise<ConsentRecord> {
  const records = await listConsentRecordsForAccount(account.accountId);
  const existing = selectLatestConsentRecord(records, 'account_legal', null, null);
  if (existing && existing.consentState === 'accepted' && existing.consentVersion === ACCOUNT_LEGAL_CONSENT_VERSION) {
    return existing;
  }

  const timestamp = nowIso();
  const consentedAt = existing?.consentState === 'accepted' ? existing.consentedAt : timestamp;
  const record: ConsentRecord = {
    consentId: existing?.consentId ?? deriveStableConsentId('account_legal', account.accountId, null, null),
    scope: 'account_legal',
    accountId: account.accountId,
    deviceId: null,
    orgId: null,
    consentVersion: ACCOUNT_LEGAL_CONSENT_VERSION,
    consentState: 'accepted',
    telemetryLevel: null,
    consentedAt,
    updatedAt: timestamp
  };

  await upsertConsentRecord(record);
  return record;
}

async function syncDeviceCaptureConsent(input: {
  accountId: string;
  deviceId: string;
  orgId: string;
  consentState: ConsentState;
  consentVersion: string;
  consentedAt: string;
  telemetryLevel: TelemetryLevel | null;
}): Promise<ConsentRecord | null> {
  const [account, organization] = await Promise.all([
    getAccountProfile(input.accountId),
    getOrganizationProfile(input.orgId)
  ]);
  if (!account || !organization) {
    return null;
  }

  if (!(await hasActiveMembership(input.accountId, input.orgId))) {
    return null;
  }

  const records = await listConsentRecordsForAccount(input.accountId);
  const existing = selectLatestConsentRecord(records, 'device_capture', input.deviceId, input.orgId);
  const record: ConsentRecord = {
    consentId: existing?.consentId ?? deriveStableConsentId('device_capture', input.accountId, input.deviceId, input.orgId),
    scope: 'device_capture',
    accountId: input.accountId,
    deviceId: input.deviceId,
    orgId: input.orgId,
    consentVersion: input.consentVersion,
    consentState: input.consentState,
    telemetryLevel: input.telemetryLevel,
    consentedAt: input.consentedAt,
    updatedAt: nowIso()
  };

  await upsertConsentRecord(record);
  return record;
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

  await ensureAccountLegalConsent(account);

  const organizations = await listAccountMembershipViews(account.accountId);
  const devices = await listDeviceProfilesForAccount(account.accountId);
  const consents = await listConsentRecordsForAccount(account.accountId);

  return {
    account,
    organizations,
    devices,
    consents
  };
}

export async function reconcileDeviceProfileFromTelemetry(input: {
  deviceId: string | null | undefined;
  machineName: string | null | undefined;
  agentVersion?: string | null | undefined;
  platform?: string | null | undefined;
  reportedAtUtc: string | null | undefined;
  accountId?: string | null | undefined;
  orgId?: string | null | undefined;
}): Promise<DeviceProfile | null> {
  const deviceId = normalizeOptionalUuid(input.deviceId);
  if (!deviceId) {
    return null;
  }

  const existing = await getDeviceProfile(deviceId);
  const timestamp = normalizeTelemetryTimestamp(input.reportedAtUtc);
  const machineName = normalizeOptionalString(input.machineName) ?? existing?.machineName ?? deviceId;
  const agentVersion = normalizeOptionalString(input.agentVersion) ?? existing?.agentVersion ?? 'unknown';
  const platform = normalizeOptionalString(input.platform) ?? existing?.platform ?? 'unknown';

  if (existing) {
    const updated: DeviceProfile = {
      ...existing,
      machineName,
      deviceDisplayName: existing.deviceDisplayName === existing.machineName ? machineName : existing.deviceDisplayName,
      platform,
      agentVersion,
      lastSeenAt: maxIso(existing.lastSeenAt, timestamp),
      updatedAt: nowIso()
    };

    await upsertDeviceProfile(updated);
    return updated;
  }

  const accountId = normalizeOptionalUuid(input.accountId);
  const orgId = normalizeOptionalUuid(input.orgId);
  const canLink = accountId !== null
    && orgId !== null
    && await canBackfillLinkedDevice(accountId, orgId);

  const profile: DeviceProfile = {
    deviceId,
    orgId: canLink ? orgId : null,
    machineName,
    deviceDisplayName: machineName,
    platform,
    agentVersion,
    status: canLink ? 'active' : 'unlinked',
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    currentAccountId: canLink ? accountId : null,
    revokedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  await upsertDeviceProfile(profile);
  return profile;
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

export async function unlinkDeviceForAccount(accountId: string, deviceId: string): Promise<DeviceProfile | null> {
  const current = await getDeviceProfile(deviceId);
  if (!current || current.currentAccountId !== accountId) {
    return null;
  }

  const timestamp = nowIso();
  const updated: DeviceProfile = {
    ...current,
    status: 'unlinked',
    orgId: null,
    currentAccountId: null,
    lastSeenAt: timestamp,
    updatedAt: timestamp
  };

  await upsertDeviceProfile(updated);
  return updated;
}

export async function registerDeviceIdentity(request: DeviceRegistrationRequest): Promise<DeviceIdentityOperationResult> {
  const existing = await getDeviceProfile(request.deviceId);

  const timestamp = nowIso();
  const profile: DeviceProfile = {
    deviceId: request.deviceId,
    orgId: existing?.orgId ?? null,
    machineName: request.machineName,
    deviceDisplayName: request.deviceDisplayName ?? existing?.deviceDisplayName ?? request.machineName,
    platform: request.platform,
    agentVersion: request.agentVersion,
    status: existing?.status ?? 'active',
    firstSeenAt: existing?.firstSeenAt ?? timestamp,
    lastSeenAt: timestamp,
    currentAccountId: existing?.currentAccountId ?? null,
    revokedAt: existing?.revokedAt ?? null,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp
  };

  await upsertDeviceProfile(profile);

  const captureConsentState = request.deviceCaptureConsentState ?? null;
  const captureConsentVersion = request.deviceCaptureConsentVersion?.trim() ?? '';
  const captureConsentedAt = request.deviceCaptureConsentedAt ?? null;
  if (request.accountId
    && request.orgId
    && profile.currentAccountId === request.accountId
    && profile.orgId === request.orgId
    && captureConsentState
    && captureConsentVersion.length > 0)
  {
    await syncDeviceCaptureConsent({
      accountId: request.accountId,
      deviceId: request.deviceId,
      orgId: request.orgId,
      consentState: captureConsentState,
      consentVersion: captureConsentVersion,
      consentedAt: captureConsentedAt ?? timestamp,
      telemetryLevel: request.deviceCaptureTelemetryLevel ?? null
    });
  }

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
    status: 'active',
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
    status: 'unlinked',
    orgId: null,
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

export async function listDevicesForAccount(accountId: string): Promise<DeviceProfile[] | null> {
  const account = await getAccountProfile(accountId);
  if (!account) {
    return null;
  }

  return listDeviceProfilesForAccount(accountId);
}
