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

export type MachineSummaryAdminView = MachineSummaryReport & JoinedIdentityFields & JoinedDeviceFields;
export type MachineActionAdminView = MachineActionEvent & JoinedIdentityFields & JoinedDeviceFields;

// Admin views expose canonical focus-episode fields and keep legacy continuity
// aliases only for migration safety. Product-facing operator copy should prefer
// focus episode, pressure, short break, and long break terminology.

export async function listJoinedMachineSummaries(): Promise<MachineSummaryAdminView[]> {
  const rows = await listMachineSummaries();
  return joinSummaries(rows);
}

export async function getJoinedMachineSummary(machineId: string): Promise<MachineSummaryAdminView | null> {
  const row = await getMachineSummary(machineId);
  if (!row) {
    return null;
  }

  const [joined] = await joinSummaries([row]);
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

async function joinSummaries(rows: MachineSummaryReport[]): Promise<MachineSummaryAdminView[]> {
  const joinCache = new IdentityJoinCache();
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      ...(await joinCache.resolve(row.accountId ?? null, row.orgId ?? null, row.deviceId ?? null))
    }))
  );
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
