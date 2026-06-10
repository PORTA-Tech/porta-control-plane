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

if (args.has('--help') || args.has('-h')) {
  console.log(`
Usage:
  node scripts/backfill-install-events.mjs [--dry-run]

What it does:
  - inserts one idempotent machine_installed growth event per known machine
  - install timestamp = earliest of: device first_seen_at (by machine name),
    earliest uptime sample, machine summary reportedAtUtc
  - safe to re-run: events are keyed machine_installed:{machineId} with
    ON CONFLICT DO NOTHING
`);
  process.exit(0);
}

const {
  ensureFleetPersistenceReady,
  getFleetDatabaseUrl,
  getFleetPersistenceMode,
  getFleetPool
} = await import('../src/store/fleetPersistence.ts');
const { listMachineSummaries } = await import('../src/store/machineSummaryStore.ts');
const { appendGrowthEvent, getGrowthEventByKey } = await import('../src/store/growthEventStore.ts');

if (getFleetPersistenceMode() !== 'postgres' || !getFleetDatabaseUrl()) {
  console.error('PORTA_CONTROL_PLANE_DATABASE_URL or DATABASE_URL must be configured for install-event backfill.');
  process.exit(1);
}

await ensureFleetPersistenceReady();
const pool = getFleetPool();
if (!pool) {
  console.error('No database pool available.');
  process.exit(1);
}

const deviceFirstSeen = new Map();
const deviceRows = await pool.query(
  'SELECT machine_name, MIN(first_seen_at) AS first_seen FROM devices GROUP BY machine_name'
);
for (const row of deviceRows.rows) {
  if (row.machine_name && row.first_seen) {
    deviceFirstSeen.set(String(row.machine_name).trim().toLowerCase(), new Date(row.first_seen));
  }
}

const uptimeFirstSample = new Map();
const uptimeRows = await pool.query(
  'SELECT machine_id, MIN(sampled_at_utc) AS first_sample FROM machine_uptime_samples GROUP BY machine_id'
);
for (const row of uptimeRows.rows) {
  if (row.machine_id && row.first_sample) {
    uptimeFirstSample.set(String(row.machine_id).trim(), new Date(row.first_sample));
  }
}

const summaries = await listMachineSummaries();
let inserted = 0;
let skipped = 0;

for (const summary of summaries) {
  const machineId = summary.machineId.trim();
  const eventKey = `machine_installed:${machineId}`;
  const existing = await getGrowthEventByKey(eventKey);
  if (existing) {
    skipped++;
    continue;
  }

  const candidates = [
    deviceFirstSeen.get(summary.machineName?.trim().toLowerCase() ?? ''),
    uptimeFirstSample.get(machineId),
    new Date(summary.reportedAtUtc)
  ].filter((date) => date instanceof Date && Number.isFinite(date.getTime()));
  const occurredAt = candidates.sort((left, right) => left.getTime() - right.getTime())[0] ?? new Date();

  if (dryRun) {
    console.log(`[dry-run] would insert ${eventKey} occurred_at=${occurredAt.toISOString()}`);
    inserted++;
    continue;
  }

  await appendGrowthEvent({
    eventKey,
    eventType: 'machine_installed',
    accountId: summary.accountId ?? null,
    userId: null,
    deviceId: summary.deviceId ?? null,
    orgId: summary.orgId ?? null,
    machineId,
    occurredAtUtc: occurredAt.toISOString(),
    source: 'backfill',
    metadata: { agentVersion: summary.agentVersion ?? null }
  });
  console.log(`inserted ${eventKey} occurred_at=${occurredAt.toISOString()}`);
  inserted++;
}

console.log(`Backfill complete. inserted=${inserted} skipped_existing=${skipped} dry_run=${dryRun}`);
process.exit(0);
