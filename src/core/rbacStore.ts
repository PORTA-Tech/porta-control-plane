import fs from 'node:fs';
import path from 'node:path';

export type RbacRole = 'admin' | 'operator' | 'auditor' | 'developer' | 'viewer';
export type RbacScope = 'fleet' | 'agent';

export interface RbacAssignmentRecord {
  user_id: string;
  role: RbacRole;
  scope: RbacScope;
  scope_id: string;
  assigned_at: string;
  assigned_by: string;
  expires_at?: string;
  reason?: string;
}

const assignmentsPath = path.resolve('.data', 'rbac-assignments.json');
const validRoles = new Set<RbacRole>(['admin', 'operator', 'auditor', 'developer', 'viewer']);
const validScopes = new Set<RbacScope>(['fleet', 'agent']);

let loaded = false;
let records: RbacAssignmentRecord[] = [];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function readIsoOrUndefined(value: unknown): string | undefined {
  if (!isNonEmptyString(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function isExpired(assignment: RbacAssignmentRecord, nowMs = Date.now()): boolean {
  if (!assignment.expires_at) return false;
  const parsed = Date.parse(assignment.expires_at);
  return Number.isFinite(parsed) && parsed <= nowMs;
}

function normalizeRecord(input: unknown): RbacAssignmentRecord | null {
  if (!input || typeof input !== 'object') return null;
  const row = input as Record<string, unknown>;
  if (!isNonEmptyString(row.user_id)) return null;
  if (!isNonEmptyString(row.role) || !validRoles.has(row.role as RbacRole)) return null;
  if (!isNonEmptyString(row.scope) || !validScopes.has(row.scope as RbacScope)) return null;
  if (!isNonEmptyString(row.scope_id)) return null;
  if (!isNonEmptyString(row.assigned_by)) return null;
  const assignedAt = readIsoOrUndefined(row.assigned_at) ?? new Date().toISOString();
  const expiresAt = readIsoOrUndefined(row.expires_at);
  return {
    user_id: row.user_id.trim(),
    role: row.role as RbacRole,
    scope: row.scope as RbacScope,
    scope_id: row.scope_id.trim(),
    assigned_at: assignedAt,
    assigned_by: row.assigned_by.trim(),
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    ...(isNonEmptyString(row.reason) ? { reason: row.reason.trim() } : {})
  };
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  if (!fs.existsSync(assignmentsPath)) {
    records = [];
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(assignmentsPath, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : [];
    records = list.map((item) => normalizeRecord(item)).filter((item): item is RbacAssignmentRecord => item !== null);
  } catch {
    records = [];
  }
}

function persist(): void {
  fs.mkdirSync(path.dirname(assignmentsPath), { recursive: true });
  const tmp = `${assignmentsPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2));
  fs.renameSync(tmp, assignmentsPath);
}

export function listRbacAssignments(includeExpired = false): RbacAssignmentRecord[] {
  ensureLoaded();
  const now = Date.now();
  const filtered = includeExpired ? records : records.filter((row) => !isExpired(row, now));
  return [...filtered].sort((a, b) => Date.parse(b.assigned_at) - Date.parse(a.assigned_at));
}

export function assignRbacRole(input: {
  user_id: string;
  role: RbacRole;
  scope: RbacScope;
  scope_id: string;
  assigned_by: string;
  reason?: string;
  expires_at?: string;
}): RbacAssignmentRecord {
  ensureLoaded();
  const nowIso = new Date().toISOString();
  const normalized: RbacAssignmentRecord = {
    user_id: input.user_id.trim(),
    role: input.role,
    scope: input.scope,
    scope_id: input.scope_id.trim(),
    assigned_at: nowIso,
    assigned_by: input.assigned_by.trim(),
    ...(input.reason && input.reason.trim().length > 0 ? { reason: input.reason.trim() } : {}),
    ...(input.expires_at && Number.isFinite(Date.parse(input.expires_at))
      ? { expires_at: new Date(Date.parse(input.expires_at)).toISOString() }
      : {})
  };
  records.push(normalized);
  persist();
  return normalized;
}

export function revokeRbacRole(input: {
  user_id: string;
  role: RbacRole;
  scope: RbacScope;
  scope_id: string;
}): number {
  ensureLoaded();
  const before = records.length;
  records = records.filter((row) => {
    return !(
      row.user_id === input.user_id
      && row.role === input.role
      && row.scope === input.scope
      && row.scope_id === input.scope_id
    );
  });
  const removed = before - records.length;
  if (removed > 0) {
    persist();
  }
  return removed;
}

export function resolveAssignedRoleForUser(userId: string, fallbackRole: RbacRole | 'agent'): RbacRole | 'agent' {
  ensureLoaded();
  const now = Date.now();
  const fleetAssignments = records
    .filter((row) => row.user_id.toLowerCase() === userId.toLowerCase())
    .filter((row) => row.scope === 'fleet')
    .filter((row) => !isExpired(row, now))
    .sort((a, b) => Date.parse(b.assigned_at) - Date.parse(a.assigned_at));

  if (fleetAssignments.length === 0) return fallbackRole;
  return fleetAssignments[0]?.role ?? fallbackRole;
}
