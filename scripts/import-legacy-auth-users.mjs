import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
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

/**
 * @typedef {'viewer' | 'operator' | 'admin' | 'auditor' | 'developer' | 'agent'} AuthRole
 * @typedef {'default' | 'env' | 'custom'} UserSource
 * @typedef {{
 *   account_id: string;
 *   user_id: string;
 *   password: string;
 *   role: AuthRole;
 *   display_name: string;
 *   avatar_url?: string;
 *   auth_provider?: 'local' | 'google' | 'microsoft' | 'sso' | null;
 *   source: UserSource;
 * }} LegacyCustomUser
 */

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const jsonOutput = args.has('--json');

if (args.has('--help') || args.has('-h')) {
  console.log(`
Usage:
  node scripts/import-legacy-auth-users.mjs [--dry-run] [--json]

What it does:
  - reads legacy custom-user JSON stores from the same paths used by authSessionStore
  - hashes plaintext legacy passwords through the current auth-user store import path
  - imports only missing custom users into auth_users

Flags:
  --dry-run   Print what would be imported without writing to auth_users
  --json      Emit machine-readable JSON summary
  `);
  process.exit(0);
}

function emit(summary) {
  if (jsonOutput) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log('Legacy auth-user import');
  console.log(`  dryRun: ${summary.dryRun}`);
  console.log(`  persistenceMode: ${summary.persistenceMode}`);
  console.log(`  discoveredFiles: ${summary.discoveredFiles}`);
  console.log(`  parsedUsers: ${summary.parsedUsers}`);
  console.log(`  existingUsers: ${summary.existingUsers}`);
  console.log(`  wouldImport: ${summary.wouldImport}`);
  console.log(`  imported: ${summary.imported}`);
  console.log(`  skipped: ${summary.skipped}`);
  if (summary.discoveredPaths.length > 0) {
    console.log('  sourcePaths:');
    for (const discoveredPath of summary.discoveredPaths) {
      console.log(`    - ${discoveredPath}`);
    }
  }
}

function parseBoolean(raw, fallback) {
  if (typeof raw !== 'string') {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function deriveStableAccountId(userId) {
  const digest = createHash('sha256').update(`porta-auth-account:${userId.trim().toLowerCase()}`).digest('hex');
  const raw = digest.slice(0, 32).split('');
  raw[12] = '4';
  const variant = Number.parseInt(raw[16] ?? '8', 16);
  raw[16] = ((variant & 0x3) | 0x8).toString(16);
  const hex = raw.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function resolveLegacyCandidatePaths() {
  const homeUsersPath = path.resolve(os.homedir(), '.porta', 'auth-users.json');
  const usersPath = process.env.AUTH_USERS_PATH && process.env.AUTH_USERS_PATH.trim().length > 0
    ? path.resolve(process.env.AUTH_USERS_PATH)
    : homeUsersPath;
  const moduleUsersPath = path.resolve(repoRoot, '.data', 'auth-users.json');
  const legacyUsersPath = path.resolve(repoRoot, '.data', 'auth-users.json');
  return [...new Set([usersPath, homeUsersPath, moduleUsersPath, legacyUsersPath])];
}

function parseUserRows(raw, source) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }

  /** @type {LegacyCustomUser[]} */
  const users = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const row = /** @type {Record<string, unknown>} */ (entry);
    const userId = typeof row.user_id === 'string' ? row.user_id.trim() : '';
    const password = typeof row.password === 'string' ? row.password : '';
    const displayName = typeof row.display_name === 'string' ? row.display_name : userId;
    const accountId = typeof row.account_id === 'string' && row.account_id.trim().length > 0
      ? row.account_id.trim()
      : deriveStableAccountId(userId);
    const role = typeof row.role === 'string' ? row.role : 'viewer';
    const avatarUrl = typeof row.avatar_url === 'string' && row.avatar_url.trim().length > 0
      ? row.avatar_url.trim()
      : undefined;
    const authProvider = typeof row.auth_provider === 'string'
      && ['local', 'google', 'microsoft', 'sso'].includes(row.auth_provider)
      ? row.auth_provider
      : 'local';

    if (!userId || !password) continue;
    if (!['viewer', 'operator', 'admin', 'auditor', 'developer', 'agent'].includes(role)) continue;

    users.push({
      account_id: accountId,
      user_id: userId,
      password,
      role,
      display_name: displayName,
      ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
      ...(authProvider ? { auth_provider: authProvider } : {}),
      source
    });
  }

  return users;
}

function loadLegacyCustomUsers() {
  const candidatePaths = resolveLegacyCandidatePaths();
  /** @type {Map<string, LegacyCustomUser>} */
  const byUserId = new Map();
  /** @type {string[]} */
  const discoveredPaths = [];

  for (const candidatePath of candidatePaths) {
    if (!fs.existsSync(candidatePath)) {
      continue;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
      const users = parseUserRows(parsed, 'custom');
      discoveredPaths.push(candidatePath);
      for (const user of users) {
        byUserId.set(user.user_id.toLowerCase(), user);
      }
    } catch {
      // Ignore malformed legacy stores; the runtime already treats them as best-effort.
    }
  }

  return {
    candidatePaths,
    discoveredPaths,
    users: [...byUserId.values()]
  };
}

const {
  ensureFleetPersistenceReady,
  getFleetDatabaseUrl,
  getFleetPersistenceMode
} = await import('../src/store/fleetPersistence.ts');
const { importLegacyAuthUsers, listAuthUserRecords } = await import('../src/store/authUserStore.ts');

const persistenceMode = getFleetPersistenceMode();
if (persistenceMode !== 'postgres' || !getFleetDatabaseUrl()) {
  console.error('PORTA_CONTROL_PLANE_DATABASE_URL or DATABASE_URL must be configured for legacy auth-user import.');
  process.exit(1);
}

await ensureFleetPersistenceReady();

const loaded = loadLegacyCustomUsers();
const existingUsers = await listAuthUserRecords();
const existingByUserId = new Set(existingUsers.map((row) => row.user_id.trim().toLowerCase()));
const wouldImport = loaded.users.filter((user) => !existingByUserId.has(user.user_id.toLowerCase())).length;

let imported = 0;
let skipped = loaded.users.length;
if (!dryRun) {
  const result = await importLegacyAuthUsers(loaded.users);
  imported = result.imported;
  skipped = result.skipped;
}

emit({
  dryRun,
  persistenceMode,
  discoveredFiles: loaded.discoveredPaths.length,
  discoveredPaths: loaded.discoveredPaths,
  parsedUsers: loaded.users.length,
  existingUsers: existingUsers.length,
  wouldImport,
  imported,
  skipped: dryRun ? loaded.users.length - wouldImport : skipped
});
