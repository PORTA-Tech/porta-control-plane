import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptDir, '..');

if (process.env.PORTA_SCRIPT_TSX_READY !== '1') {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', scriptPath, ...process.argv.slice(2)],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        PORTA_SCRIPT_TSX_READY: '1'
      }
    }
  );
  process.exit(result.status ?? 1);
}

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const jsonOutput = args.has('--json');

if (args.has('--help') || args.has('-h')) {
  console.log(`
Usage:
  node scripts/backfill-growth-facts.mjs [--dry-run] [--json]

What it does:
  - backfills lifecycle growth facts from normalized control-plane tables
  - imports only real account_registered, membership_joined, device_linked, and device_capture_consented events
  - recomputes account_activated from the newly backfilled lifecycle facts plus any existing real active-day records
  - never writes historical account_active_day rows, so pre-launch retention stays unavailable

Flags:
  --dry-run   Print what would be backfilled without writing to growth_events
  --json      Emit machine-readable JSON summary
  `);
  process.exit(0);
}

function normalizeTimestamp(input) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return null;
  }

  const parsed = Date.parse(input);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function maxIso(values) {
  const normalized = values
    .map((value) => normalizeTimestamp(value))
    .filter((value) => value !== null)
    .sort((left, right) => Date.parse(left) - Date.parse(right));

  return normalized[normalized.length - 1] ?? null;
}

function emit(summary) {
  if (jsonOutput) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log('Growth facts backfill');
  console.log(`  dryRun: ${summary.dryRun}`);
  console.log(`  persistenceMode: ${summary.persistenceMode}`);
  console.log(`  customUsers: ${summary.customUsers}`);
  console.log(`  accountProfiles: ${summary.accountProfiles}`);
  console.log(`  memberships: ${summary.memberships}`);
  console.log(`  devices: ${summary.devices}`);
  console.log(`  consents: ${summary.consents}`);
  console.log(`  activationEvaluated: ${summary.activationEvaluated}`);
  console.log(`  activationEventsCreated: ${summary.activationEventsCreated}`);
  console.log('  events:');
  for (const [eventType, stats] of Object.entries(summary.events)) {
    console.log(`    ${eventType}:`);
    console.log(`      discovered: ${stats.discovered}`);
    console.log(`      eligible: ${stats.eligible}`);
    console.log(`      existing: ${stats.existing}`);
    console.log(`      inserted: ${stats.inserted}`);
    console.log(`      skippedMissingData: ${stats.skippedMissingData}`);
    if (typeof stats.skippedSemanticDuplicate === 'number') {
      console.log(`      skippedSemanticDuplicate: ${stats.skippedSemanticDuplicate}`);
    }
  }
  console.log('  retention: historical account_active_day rows were not backfilled.');
}

function createStats() {
  return {
    discovered: 0,
    eligible: 0,
    existing: 0,
    inserted: 0,
    skippedMissingData: 0
  };
}

function createDeviceLinkStats() {
  return {
    ...createStats(),
    skippedSemanticDuplicate: 0
  };
}

function looksLikeSelfServeUserId(userId) {
  return typeof userId === 'string' && userId.includes('@');
}

function buildMembershipKey(accountId, orgId) {
  return `${accountId}|${orgId}`;
}

function buildDeviceLinkIdentity(accountId, deviceId, orgId) {
  return `${accountId}|${deviceId}|${orgId}`;
}

function inferDeviceLinkedAt(account, membership, device) {
  return maxIso([
    account?.createdAt ?? null,
    membership?.joinedAt ?? null,
    membership?.createdAt ?? null,
    device?.firstSeenAt ?? null,
    device?.createdAt ?? null
  ]);
}

const {
  ensureFleetPersistenceReady,
  getFleetDatabaseUrl,
  getFleetPersistenceMode
} = await import('../src/store/fleetPersistence.ts');
const { listAuthUserRecords } = await import('../src/store/authUserStore.ts');
const { listAccountProfiles } = await import('../src/store/accountStore.ts');
const { listMemberships } = await import('../src/store/membershipStore.ts');
const { listDeviceProfiles } = await import('../src/store/deviceStore.ts');
const { listConsentRecords } = await import('../src/store/consentRecordStore.ts');
const { appendGrowthEvent, listGrowthEvents } = await import('../src/store/growthEventStore.ts');
const { maybeActivateAccount } = await import('../src/core/growthService.ts');

const persistenceMode = getFleetPersistenceMode();
if (persistenceMode !== 'postgres' || !getFleetDatabaseUrl()) {
  console.error('PORTA_CONTROL_PLANE_DATABASE_URL or DATABASE_URL must be configured for growth-fact backfill.');
  process.exit(1);
}

await ensureFleetPersistenceReady();

const [
  authUsers,
  accounts,
  memberships,
  devices,
  consents,
  existingGrowthEvents
] = await Promise.all([
  listAuthUserRecords(),
  listAccountProfiles(),
  listMemberships(),
  listDeviceProfiles(),
  listConsentRecords(),
  listGrowthEvents()
]);

const customUsers = authUsers.filter((user) => user.source === 'custom');
const accountById = new Map(accounts.map((account) => [account.accountId, account]));
const growthUserByAccountId = new Map(customUsers.map((user) => [user.account_id, {
  account_id: user.account_id,
  user_id: user.user_id
}]));
for (const account of accounts) {
  if (growthUserByAccountId.has(account.accountId) || !looksLikeSelfServeUserId(account.primaryEmail)) {
    continue;
  }

  growthUserByAccountId.set(account.accountId, {
    account_id: account.accountId,
    user_id: account.primaryEmail
  });
}
const membershipByAccountOrg = new Map(
  memberships.map((membership) => [buildMembershipKey(membership.accountId, membership.orgId), membership])
);
const existingEventKeys = new Set(existingGrowthEvents.map((event) => event.eventKey));
const existingDeviceLinkIdentities = new Set(
  existingGrowthEvents
    .filter((event) => event.eventType === 'device_linked')
    .filter((event) => event.accountId && event.deviceId && event.orgId)
    .map((event) => buildDeviceLinkIdentity(event.accountId, event.deviceId, event.orgId))
);
const existingConsentIdentities = new Set(
  existingGrowthEvents
    .filter((event) => event.eventType === 'device_capture_consented')
    .map((event) => {
      const consentId = event.metadata?.consentId;
      return typeof consentId === 'string' && consentId.trim().length > 0 ? consentId : null;
    })
    .filter((value) => value !== null)
);

const stats = {
  account_registered: createStats(),
  membership_joined: createStats(),
  device_linked: createDeviceLinkStats(),
  device_capture_consented: createStats()
};

async function appendBackfillEvent(input, eventStats) {
  eventStats.eligible += 1;
  if (existingEventKeys.has(input.eventKey)) {
    eventStats.existing += 1;
    return false;
  }

  if (!dryRun) {
    await appendGrowthEvent(input);
  }
  existingEventKeys.add(input.eventKey);
  eventStats.inserted += 1;
  return true;
}

for (const account of accounts) {
  stats.account_registered.discovered += 1;
  const authUser = growthUserByAccountId.get(account.accountId);
  const occurredAtUtc = normalizeTimestamp(account.createdAt);
  if (!authUser || !occurredAtUtc) {
    stats.account_registered.skippedMissingData += 1;
    continue;
  }

  await appendBackfillEvent({
    eventKey: `account_registered:${account.accountId}`,
    eventType: 'account_registered',
    accountId: account.accountId,
    userId: authUser.user_id,
    occurredAtUtc,
    source: 'growth_backfill',
    metadata: {
      backfilled: true
    }
  }, stats.account_registered);
}

for (const membership of memberships) {
  stats.membership_joined.discovered += 1;
  const authUser = growthUserByAccountId.get(membership.accountId);
  const occurredAtUtc = normalizeTimestamp(membership.joinedAt);
  if (!authUser || !occurredAtUtc) {
    stats.membership_joined.skippedMissingData += 1;
    continue;
  }

  await appendBackfillEvent({
    eventKey: `membership_joined:${membership.membershipId}`,
    eventType: 'membership_joined',
    accountId: membership.accountId,
    userId: authUser.user_id,
    orgId: membership.orgId,
    occurredAtUtc,
    source: 'growth_backfill',
    metadata: {
      backfilled: true,
      membershipId: membership.membershipId,
      membershipRole: membership.role,
      membershipStatus: membership.status
    }
  }, stats.membership_joined);
}

for (const device of devices) {
  stats.device_linked.discovered += 1;
  const accountId = device.currentAccountId ?? null;
  const orgId = device.orgId ?? null;
  if (!accountId || !orgId) {
    stats.device_linked.skippedMissingData += 1;
    continue;
  }

  const authUser = growthUserByAccountId.get(accountId);
  const account = accountById.get(accountId);
  const membership = membershipByAccountOrg.get(buildMembershipKey(accountId, orgId));
  if (!authUser || !account || !membership) {
    stats.device_linked.skippedMissingData += 1;
    continue;
  }

  const semanticIdentity = buildDeviceLinkIdentity(accountId, device.deviceId, orgId);
  if (existingDeviceLinkIdentities.has(semanticIdentity)) {
    stats.device_linked.skippedSemanticDuplicate += 1;
    continue;
  }

  const occurredAtUtc = inferDeviceLinkedAt(account, membership, device);
  if (!occurredAtUtc) {
    stats.device_linked.skippedMissingData += 1;
    continue;
  }

  const inserted = await appendBackfillEvent({
    eventKey: `device_linked:${device.deviceId}:${accountId}:${orgId}:${occurredAtUtc}`,
    eventType: 'device_linked',
    accountId,
    userId: authUser.user_id,
    deviceId: device.deviceId,
    orgId,
    occurredAtUtc,
    source: 'growth_backfill',
    metadata: {
      backfilled: true,
      machineName: device.machineName,
      platform: device.platform,
      inferredTimestamp: true,
      timestampBasis: 'max(account.createdAt,membership.joinedAt,membership.createdAt,device.firstSeenAt,device.createdAt)'
    }
  }, stats.device_linked);

  if (inserted) {
    existingDeviceLinkIdentities.add(semanticIdentity);
  }
}

for (const consent of consents) {
  stats.device_capture_consented.discovered += 1;
  const authUser = consent.accountId ? growthUserByAccountId.get(consent.accountId) : null;
  const occurredAtUtc = normalizeTimestamp(consent.consentedAt);
  if (
    !authUser
    || consent.scope !== 'device_capture'
    || consent.consentState !== 'accepted'
    || !consent.accountId
    || !consent.deviceId
    || !consent.orgId
    || !occurredAtUtc
  ) {
    stats.device_capture_consented.skippedMissingData += 1;
    continue;
  }

  if (existingConsentIdentities.has(consent.consentId)) {
    stats.device_capture_consented.existing += 1;
    continue;
  }

  await appendBackfillEvent({
    eventKey: `device_capture_consented:${consent.consentId}:${consent.consentVersion}:${occurredAtUtc}`,
    eventType: 'device_capture_consented',
    accountId: consent.accountId,
    userId: authUser.user_id,
    deviceId: consent.deviceId,
    orgId: consent.orgId,
    occurredAtUtc,
    source: 'growth_backfill',
    metadata: {
      backfilled: true,
      consentId: consent.consentId,
      consentVersion: consent.consentVersion,
      telemetryLevel: consent.telemetryLevel ?? null
    }
  }, stats.device_capture_consented);
  existingConsentIdentities.add(consent.consentId);
}

let activationEventsCreated = 0;
for (const growthUser of growthUserByAccountId.values()) {
  const activationKey = `account_activated:${growthUser.account_id}`;
  const hadActivation = existingEventKeys.has(activationKey);
  if (!dryRun) {
    const activation = await maybeActivateAccount(growthUser.account_id);
    if (!hadActivation && activation) {
      existingEventKeys.add(activationKey);
      activationEventsCreated += 1;
    }
  }
}

emit({
  dryRun,
  persistenceMode,
  customUsers: growthUserByAccountId.size,
  accountProfiles: accounts.length,
  memberships: memberships.length,
  devices: devices.length,
  consents: consents.length,
  activationEvaluated: growthUserByAccountId.size,
  activationEventsCreated,
  events: stats,
  retentionBackfilled: false
});
