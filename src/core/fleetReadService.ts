import type { MachineActionEvent, MachineSummaryReport, Membership } from '@porta/api-contracts';
import { getAccountProfile } from '../store/accountStore.js';
import { getDeviceProfile } from '../store/deviceStore.js';
import { listMembershipsForAccount } from '../store/membershipStore.js';
import { getOrganizationProfile } from '../store/organizationStore.js';
import { getMachineSummary, listMachineSummaries } from '../store/machineSummaryStore.js';
import {
  listMachineActionEventsForMachine,
  listRecentMachineActionEvents
} from '../store/machineActionStore.js';

export interface JoinedIdentityFields {
  displayName: string | null;
  primaryEmail: string | null;
  orgName: string | null;
  role: string | null;
}

export interface JoinedDeviceFields {
  deviceStatus: string | null;
  deviceRevokedAt: string | null;
}

// Server-derived truth fields so the console never has to guess:
// - presence is liveness (deviceStatus only means "credential not revoked")
// - hasInputData guards against rendering metrics computed from zero input
// - selfTestEffective surfaces a self-test frozen at "pending" (dead capture loop)
// - agentOutdated compares against the newest version seen anywhere in the fleet
export interface DerivedFleetHealthFields {
  presence: 'online' | 'recent' | 'offline';
  offlineSinceUtc: string | null;
  hasInputData: boolean;
  selfTestEffective: string | null;
  agentOutdated: boolean;
  latestKnownAgentVersion: string | null;
}

export type MachineSummaryAdminView = MachineSummaryReport & JoinedIdentityFields & JoinedDeviceFields & DerivedFleetHealthFields;
export type MachineActionAdminView = MachineActionEvent & JoinedIdentityFields & JoinedDeviceFields;

// Admin views expose canonical focus-episode fields and keep legacy continuity
// aliases only for migration safety. Product-facing operator copy should prefer
// focus episode, pressure, short break, and long break terminology.

export async function listJoinedMachineSummaries(): Promise<MachineSummaryAdminView[]> {
  const rows = await listMachineSummaries();
  return joinSummaries(rows, resolveLatestAgentVersion(rows));
}

export async function getJoinedMachineSummary(machineId: string): Promise<MachineSummaryAdminView | null> {
  const row = await getMachineSummary(machineId);
  if (!row) {
    return null;
  }

  const allRows = await listMachineSummaries();
  const [joined] = await joinSummaries([row], resolveLatestAgentVersion(allRows));
  return joined ?? null;
}

export async function listJoinedMachineActionEventsForMachine(
  machineId: string,
  limit = 100
): Promise<MachineActionAdminView[]> {
  const rows = await listMachineActionEventsForMachine(machineId, limit);
  return joinActions(rows);
}

export async function listRecentJoinedMachineActionEvents(limit = 100): Promise<MachineActionAdminView[]> {
  const rows = await listRecentMachineActionEvents(limit);
  return joinActions(rows);
}

async function joinSummaries(
  rows: MachineSummaryReport[],
  latestAgentVersion: string | null
): Promise<MachineSummaryAdminView[]> {
  const joinCache = new IdentityJoinCache();
  const nowMs = Date.now();
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      ...(await joinCache.resolve(row.accountId ?? null, row.orgId ?? null, row.deviceId ?? null)),
      ...deriveFleetHealthFields(row, latestAgentVersion, nowMs)
    }))
  );
}

function parseVersionTuple(version: unknown): [number, number, number] | null {
  if (typeof version !== 'string') {
    return null;
  }

  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersionTuples(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) {
      return (left[index] ?? 0) - (right[index] ?? 0);
    }
  }

  return 0;
}

function resolveLatestAgentVersion(rows: MachineSummaryReport[]): string | null {
  let latest: { version: string; tuple: [number, number, number] } | null = null;
  for (const row of rows) {
    const tuple = parseVersionTuple(row.agentVersion);
    if (!tuple) {
      continue;
    }

    if (!latest || compareVersionTuples(tuple, latest.tuple) > 0) {
      latest = { version: row.agentVersion.trim(), tuple };
    }
  }

  return latest?.version ?? null;
}

function isVersionAtLeastTuple(version: unknown, target: [number, number, number]): boolean {
  const tuple = parseVersionTuple(version);
  if (!tuple) {
    return false;
  }

  return compareVersionTuples(tuple, target) >= 0;
}

function deriveFleetHealthFields(
  row: MachineSummaryReport,
  latestAgentVersion: string | null,
  nowMs: number
): DerivedFleetHealthFields {
  const reportedMs = Date.parse(row.reportedAtUtc);
  const ageSeconds = Number.isFinite(reportedMs) ? (nowMs - reportedMs) / 1000 : Number.POSITIVE_INFINITY;
  const presence: DerivedFleetHealthFields['presence'] =
    ageSeconds <= 120 ? 'online' : ageSeconds <= 3600 ? 'recent' : 'offline';
  const offlineSinceUtc = presence === 'offline' && Number.isFinite(reportedMs) ? row.reportedAtUtc : null;

  // Agents below 1.2.82 fabricated last-input timestamps, so for them only the
  // instantaneous activity flag proves real input ever flowed.
  const hasInputData = isVersionAtLeastTuple(row.agentVersion, [1, 2, 82])
    ? row.lastAcceptedInputAgeSeconds !== null && row.lastAcceptedInputAgeSeconds !== undefined
    : row.activityDetected === true;

  const rawSelfTestState = (row as MachineSummaryReport & { userAgentSelfTestState?: string | null }).userAgentSelfTestState ?? null;
  const selfTestEffective = rawSelfTestState === 'pending' && presence !== 'offline' && !hasInputData
    ? 'stale_pending'
    : rawSelfTestState;

  const latestTuple = latestAgentVersion ? parseVersionTuple(latestAgentVersion) : null;
  const rowTuple = parseVersionTuple(row.agentVersion);
  const agentOutdated = Boolean(latestTuple && rowTuple && compareVersionTuples(rowTuple, latestTuple) < 0);

  return {
    presence,
    offlineSinceUtc,
    hasInputData,
    selfTestEffective,
    agentOutdated,
    latestKnownAgentVersion: latestAgentVersion
  };
}

async function joinActions(rows: MachineActionEvent[]): Promise<MachineActionAdminView[]> {
  const joinCache = new IdentityJoinCache();
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      ...(await joinCache.resolve(row.accountId ?? null, row.orgId ?? null, row.deviceId ?? null))
    }))
  );
}

class IdentityJoinCache {
  private readonly accountCache = new Map<string, ReturnType<typeof getAccountProfile>>();
  private readonly deviceCache = new Map<string, ReturnType<typeof getDeviceProfile>>();
  private readonly organizationCache = new Map<string, ReturnType<typeof getOrganizationProfile>>();
  private readonly membershipCache = new Map<string, Promise<Membership[]>>();

  async resolve(accountId: string | null, orgId: string | null, deviceId: string | null): Promise<JoinedIdentityFields & JoinedDeviceFields> {
    if (!accountId && !orgId && !deviceId) {
      return emptyJoinFields();
    }

    const [account, device, organization, memberships] = await Promise.all([
      accountId ? this.getAccount(accountId) : Promise.resolve(null),
      deviceId ? this.getDevice(deviceId) : Promise.resolve(null),
      orgId ? this.getOrganization(orgId) : Promise.resolve(null),
      accountId ? this.getMemberships(accountId) : Promise.resolve([])
    ]);

    const membership = accountId && orgId ? selectMembership(memberships, accountId, orgId) : null;

    return {
      displayName: account?.displayName ?? null,
      primaryEmail: account?.primaryEmail ?? null,
      orgName: organization?.orgName ?? null,
      role: membership?.role ?? null,
      deviceStatus: device?.status ?? null,
      deviceRevokedAt: device?.revokedAt ?? null
    };
  }

  private getAccount(accountId: string) {
    let promise = this.accountCache.get(accountId);
    if (!promise) {
      promise = getAccountProfile(accountId);
      this.accountCache.set(accountId, promise);
    }

    return promise;
  }

  private getOrganization(orgId: string) {
    let promise = this.organizationCache.get(orgId);
    if (!promise) {
      promise = getOrganizationProfile(orgId);
      this.organizationCache.set(orgId, promise);
    }

    return promise;
  }

  private getMemberships(accountId: string) {
    let promise = this.membershipCache.get(accountId);
    if (!promise) {
      promise = listMembershipsForAccount(accountId);
      this.membershipCache.set(accountId, promise);
    }

    return promise;
  }

  private getDevice(deviceId: string) {
    let promise = this.deviceCache.get(deviceId);
    if (!promise) {
      promise = getDeviceProfile(deviceId);
      this.deviceCache.set(deviceId, promise);
    }

    return promise;
  }
}

function selectMembership(memberships: Membership[], accountId: string, orgId: string): Membership | null {
  const exact = memberships.filter((membership) => membership.accountId === accountId && membership.orgId === orgId);
  return (
    exact.find((membership) => membership.status === 'active') ??
    exact.find((membership) => membership.status === 'invited') ??
    exact[0] ??
    null
  );
}

function emptyJoinFields(): JoinedIdentityFields & JoinedDeviceFields {
  return {
    displayName: null,
    primaryEmail: null,
    orgName: null,
    role: null,
    deviceStatus: null,
    deviceRevokedAt: null
  };
}
