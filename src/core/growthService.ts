import type { ConsentRecord, Membership } from '@porta/api-contracts';
import { getFleetPersistenceMode } from '../store/fleetPersistence.js';
import { findAuthUserRecordByUserId } from '../store/authUserStore.js';
import { getAccountProfile } from '../store/accountStore.js';
import { listMembershipsForAccount } from '../store/membershipStore.js';
import { listDeviceProfilesForAccount } from '../store/deviceStore.js';
import { listConsentRecordsForAccount } from '../store/consentRecordStore.js';
import {
  appendGrowthEvent,
  getGrowthEventByKey,
  type AppendGrowthEventInput,
  type GrowthEventMetadata,
  type GrowthEventRecord
} from '../store/growthEventStore.js';
import {
  listAccountActiveDaysForAccount,
  upsertAccountActiveDay,
  type AccountActiveDayRecord
} from '../store/accountActiveDayStore.js';

export interface RecordAccountActiveDayInput {
  accountId: string;
  activityAtUtc: string;
  machineId?: string | null;
  orgId?: string | null;
  userId?: string | null;
  source: string;
  sourceCount?: number;
  metadata?: GrowthEventMetadata;
}

function normalizeTimestamp(input: string): string {
  const parsed = Date.parse(input);
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}

function activityDateFromTimestamp(input: string): string {
  return normalizeTimestamp(input).slice(0, 10);
}

function compareIsoAscending(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

function maxIso(values: string[]): string {
  return values.sort(compareIsoAscending)[values.length - 1] ?? new Date().toISOString();
}

function selectLatestConsentByDevice(records: ConsentRecord[]): Map<string, ConsentRecord> {
  const sorted = [...records].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const table = new Map<string, ConsentRecord>();
  for (const record of sorted) {
    const key = `${record.deviceId ?? ''}:${record.orgId ?? ''}`;
    if (!table.has(key)) {
      table.set(key, record);
    }
  }
  return table;
}

function membershipReadyAt(membership: Membership): string {
  return normalizeTimestamp(membership.joinedAt ?? membership.createdAt ?? membership.updatedAt);
}

function looksLikeSelfServeUserId(userId: string): boolean {
  return userId.includes('@');
}

async function isGrowthEligibleAccount(accountId: string, userId: string): Promise<boolean> {
  if (getFleetPersistenceMode() !== 'postgres') {
    return looksLikeSelfServeUserId(userId);
  }

  const authUser = await findAuthUserRecordByUserId(userId);
  if (!authUser) {
    // Production may temporarily have materialized account/device state before auth_users is backfilled.
    return looksLikeSelfServeUserId(userId);
  }

  return Boolean(authUser.account_id === accountId && authUser.source === 'custom' && authUser.status === 'active');
}

export async function shouldTrackGrowthAccount(accountId: string, userId?: string | null): Promise<boolean> {
  const resolvedUserId = userId ?? (await getAccountProfile(accountId))?.primaryEmail ?? '';
  if (!resolvedUserId) {
    return false;
  }

  return isGrowthEligibleAccount(accountId, resolvedUserId);
}

export async function recordGrowthEvent(input: AppendGrowthEventInput): Promise<GrowthEventRecord> {
  return appendGrowthEvent({
    ...input,
    occurredAtUtc: normalizeTimestamp(input.occurredAtUtc)
  });
}

// Records the first-ever contact from a machine as an install event. Idempotent via
// the unique eventKey, so callers may invoke it on every report. accountId is null
// for machines whose user never signed up — that is the point: installs are the top
// of the growth funnel and must be counted even when no account exists.
export async function recordMachineInstalledEvent(input: {
  machineId: string;
  agentVersion?: string | null;
  accountId?: string | null;
  orgId?: string | null;
  deviceId?: string | null;
  occurredAtUtc: string;
  source?: string;
}): Promise<GrowthEventRecord | null> {
  const machineId = input.machineId?.trim();
  if (!machineId) {
    return null;
  }

  return recordGrowthEvent({
    eventKey: `machine_installed:${machineId}`,
    eventType: 'machine_installed',
    accountId: input.accountId ?? null,
    userId: null,
    deviceId: input.deviceId ?? null,
    orgId: input.orgId ?? null,
    machineId,
    occurredAtUtc: input.occurredAtUtc,
    source: input.source ?? 'machine_summary',
    metadata: {
      agentVersion: input.agentVersion ?? null
    }
  });
}

export async function recordLifecycleGrowthEvent(input: AppendGrowthEventInput & {
  accountId: string;
  userId?: string | null;
}): Promise<GrowthEventRecord | null> {
  const account = await getAccountProfile(input.accountId);
  if (!account) {
    return null;
  }

  const userId = input.userId ?? account.primaryEmail;
  if (!(await shouldTrackGrowthAccount(input.accountId, userId))) {
    return null;
  }

  return recordGrowthEvent({
    ...input,
    userId
  });
}

export async function recordAccountActiveDay(
  input: RecordAccountActiveDayInput
): Promise<{ activeDay: AccountActiveDayRecord; event: GrowthEventRecord } | null> {
  const occurredAtUtc = normalizeTimestamp(input.activityAtUtc);
  const activityDate = activityDateFromTimestamp(occurredAtUtc);
  const account = await getAccountProfile(input.accountId);
  if (!account) {
    return null;
  }

  const userId = input.userId ?? account.primaryEmail;
  if (!(await shouldTrackGrowthAccount(input.accountId, userId))) {
    return null;
  }

  const activeDay = await upsertAccountActiveDay({
    accountId: input.accountId,
    activityDate,
    firstActivityAtUtc: occurredAtUtc,
    lastActivityAtUtc: occurredAtUtc,
    lastMachineId: input.machineId ?? null,
    sourceCount: input.sourceCount ?? 1,
    updatedAtUtc: occurredAtUtc
  });

  const event = await appendGrowthEvent({
    eventKey: `account_active_day:${input.accountId}:${activityDate}`,
    eventType: 'account_active_day',
    accountId: input.accountId,
    userId,
    orgId: input.orgId ?? null,
    machineId: input.machineId ?? null,
    occurredAtUtc: activeDay.lastActivityAtUtc,
    activityDate: activeDay.activityDate,
    source: input.source,
    metadata: {
      sourceCount: activeDay.sourceCount,
      ...(input.metadata ?? {})
    }
  });

  return { activeDay, event };
}

export async function maybeActivateAccount(accountId: string): Promise<GrowthEventRecord | null> {
  const activationKey = `account_activated:${accountId}`;
  const existingActivation = await getGrowthEventByKey(activationKey);
  if (existingActivation) {
    return existingActivation;
  }

  const account = await getAccountProfile(accountId);
  if (!account) {
    return null;
  }

  if (!(await isGrowthEligibleAccount(accountId, account.primaryEmail))) {
    return null;
  }

  const [memberships, devices, consents, activeDays] = await Promise.all([
    listMembershipsForAccount(accountId),
    listDeviceProfilesForAccount(accountId),
    listConsentRecordsForAccount(accountId),
    listAccountActiveDaysForAccount(accountId)
  ]);

  if (activeDays.length === 0) {
    return null;
  }

  const earliestActiveDay = [...activeDays].sort((left, right) =>
    Date.parse(left.firstActivityAtUtc) - Date.parse(right.firstActivityAtUtc))[0];
  if (!earliestActiveDay) {
    return null;
  }

  const activeMemberships = memberships.filter((membership) => membership.status === 'active');
  if (activeMemberships.length === 0) {
    return null;
  }

  const membershipsByOrg = new Map(activeMemberships.map((membership) => [membership.orgId, membership]));
  const linkedDevices = devices.filter((device) =>
    device.status === 'active'
    && device.currentAccountId === accountId
    && typeof device.orgId === 'string'
    && device.orgId.length > 0
    && membershipsByOrg.has(device.orgId));
  if (linkedDevices.length === 0) {
    return null;
  }

  const latestConsents = selectLatestConsentByDevice(
    consents.filter((record) => record.scope === 'device_capture')
  );

  let winningEvent: GrowthEventRecord | null = null;
  let winningOccurredAt: string | null = null;
  let winningDeviceId: string | null = null;
  let winningOrgId: string | null = null;
  let winningMembershipId: string | null = null;

  for (const device of linkedDevices) {
    const orgId = device.orgId ?? null;
    if (!orgId) {
      continue;
    }

    const membership = membershipsByOrg.get(orgId);
    if (!membership) {
      continue;
    }

    const consentKey = `${device.deviceId}:${orgId}`;
    const consent = latestConsents.get(consentKey);
    if (!consent || consent.consentState !== 'accepted') {
      continue;
    }

    const occurredAtUtc = maxIso([
      membershipReadyAt(membership),
      normalizeTimestamp(device.updatedAt),
      normalizeTimestamp(consent.consentedAt ?? consent.updatedAt),
      normalizeTimestamp(earliestActiveDay.firstActivityAtUtc)
    ]);

    if (!winningOccurredAt || compareIsoAscending(occurredAtUtc, winningOccurredAt) < 0) {
      winningOccurredAt = occurredAtUtc;
      winningDeviceId = device.deviceId;
      winningOrgId = orgId;
      winningMembershipId = membership.membershipId;
    }
  }

  if (!winningOccurredAt) {
    return null;
  }

  winningEvent = await appendGrowthEvent({
    eventKey: activationKey,
    eventType: 'account_activated',
    accountId,
    userId: account.primaryEmail,
    deviceId: winningDeviceId,
    orgId: winningOrgId,
    occurredAtUtc: winningOccurredAt,
    activityDate: earliestActiveDay.activityDate,
    source: 'growth_activation',
    metadata: {
      activeDayCount: activeDays.length,
      membershipId: winningMembershipId,
      ...(winningDeviceId ? { deviceId: winningDeviceId } : {}),
      ...(winningOrgId ? { orgId: winningOrgId } : {})
    }
  });

  return winningEvent;
}
