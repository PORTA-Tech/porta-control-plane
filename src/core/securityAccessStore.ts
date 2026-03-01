import fs from 'node:fs';
import path from 'node:path';
import type { OperatorRole } from '../api/middleware/auth.js';
import { readOperatorAuditEvents } from './operatorAudit.js';

type SecurityRole = Exclude<OperatorRole, 'agent'>;

export interface SecurityRoleView {
  role: SecurityRole;
  description: string;
  sensitive_actions: string[];
}

export interface SecurityPermissionsMatrixRow {
  role: SecurityRole;
  read: boolean;
  write: boolean;
  override: boolean;
  sensitive_actions: string[];
}

export interface SecurityEventView {
  timestamp_utc: string;
  user_id: string | null;
  role: string | null;
  attempted_action: string;
  resource: string | null;
  scope: string | null;
  scope_id: string | null;
  result: 'DENIED' | 'ALLOWED' | 'UNKNOWN';
  reason_code: string | null;
  correlation_id: string | null;
  trace_id: string | null;
}

export interface SensitivePolicyView {
  reauth_window_minutes: number;
  require_2fa_override: boolean;
  sensitive_actions: string[];
  blocked_missing_reauth_last_1h: number;
  expired_sessions: number;
  source: string;
  updated_at_utc: string | null;
}

const sensitivePolicyPath = path.resolve('.data', 'security-sensitive-policy.json');

const roleDefinitions: Array<{
  role: SecurityRole;
  description: string;
  read: boolean;
  write: boolean;
  override: boolean;
  sensitive_actions: string[];
  permissions: string[];
}> = [
  {
    role: 'admin',
    description: 'Full access, including RBAC assignment and high-impact operations.',
    read: true,
    write: true,
    override: true,
    sensitive_actions: ['rollout.promote', 'rollout.halt', 'rollout.rollback', 'policy.deploy', 'config.submit', 'rbac.assign', 'rbac.revoke'],
    permissions: ['read', 'write', 'override', 'rbac.assign', 'rbac.revoke', 'policy.deploy', 'rollout.promote', 'rollout.halt', 'rollout.rollback']
  },
  {
    role: 'operator',
    description: 'Operational mutations except RBAC assignment and admin-only controls.',
    read: true,
    write: true,
    override: false,
    sensitive_actions: ['rollout.promote', 'rollout.halt', 'rollout.rollback', 'policy.deploy', 'config.submit'],
    permissions: ['read', 'write', 'policy.deploy', 'rollout.promote', 'rollout.halt', 'rollout.rollback']
  },
  {
    role: 'auditor',
    description: 'Read-only access for security and trace verification.',
    read: true,
    write: false,
    override: false,
    sensitive_actions: [],
    permissions: ['read', 'audit.read', 'trace.verify']
  },
  {
    role: 'developer',
    description: 'Read-only diagnostics access.',
    read: true,
    write: false,
    override: false,
    sensitive_actions: [],
    permissions: ['read']
  },
  {
    role: 'viewer',
    description: 'Basic read-only access.',
    read: true,
    write: false,
    override: false,
    sensitive_actions: [],
    permissions: ['read']
  }
];

const defaultSensitivePolicy: SensitivePolicyView = {
  reauth_window_minutes: 10,
  require_2fa_override: false,
  sensitive_actions: [
    'rollout.promote',
    'rollout.halt',
    'rollout.rollback',
    'policy.deploy',
    'config.submit',
    'rbac.assign',
    'rbac.revoke'
  ],
  blocked_missing_reauth_last_1h: 0,
  expired_sessions: 0,
  source: 'control_plane',
  updated_at_utc: null
};

function parseWindowMillis(window: '15m' | '1h' | '24h'): number {
  if (window === '24h') return 24 * 60 * 60 * 1000;
  if (window === '1h') return 60 * 60 * 1000;
  return 15 * 60 * 1000;
}

function normalizeResult(action: string, reason: string | null): 'DENIED' | 'ALLOWED' | 'UNKNOWN' {
  const value = `${action} ${reason ?? ''}`.toLowerCase();
  if (value.includes('denied') || value.includes('forbidden') || value.includes('rejected')) return 'DENIED';
  if (value.includes('assign') || value.includes('revoke') || value.includes('allow') || value.includes('updated')) return 'ALLOWED';
  return 'UNKNOWN';
}

export function listSecurityRoles(): SecurityRoleView[] {
  return roleDefinitions.map((row) => ({
    role: row.role,
    description: row.description,
    sensitive_actions: row.sensitive_actions
  }));
}

export function readSecurityPermissionsMatrix(): { rows: SecurityPermissionsMatrixRow[]; source: string; updated_at_utc: string } {
  return {
    rows: roleDefinitions.map((row) => ({
      role: row.role,
      read: row.read,
      write: row.write,
      override: row.override,
      sensitive_actions: row.sensitive_actions
    })),
    source: 'control_plane_rbac',
    updated_at_utc: new Date().toISOString()
  };
}

export function readPermissionsForRole(role: string): string[] {
  const found = roleDefinitions.find((row) => row.role === role);
  return found ? [...found.permissions] : ['read'];
}

function readSensitivePolicyStored(): SensitivePolicyView {
  if (!fs.existsSync(sensitivePolicyPath)) {
    return { ...defaultSensitivePolicy };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(sensitivePolicyPath, 'utf8')) as Record<string, unknown>;
    const reauthWindow = Number(parsed.reauth_window_minutes);
    const updatedAt = typeof parsed.updated_at_utc === 'string' ? parsed.updated_at_utc : null;
    return {
      reauth_window_minutes: Number.isFinite(reauthWindow) ? Math.max(1, Math.trunc(reauthWindow)) : defaultSensitivePolicy.reauth_window_minutes,
      require_2fa_override: Boolean(parsed.require_2fa_override ?? defaultSensitivePolicy.require_2fa_override),
      sensitive_actions: Array.isArray(parsed.sensitive_actions)
        ? parsed.sensitive_actions.map((value) => String(value))
        : defaultSensitivePolicy.sensitive_actions,
      blocked_missing_reauth_last_1h: 0,
      expired_sessions: 0,
      source: 'control_plane',
      updated_at_utc: updatedAt
    };
  } catch {
    return { ...defaultSensitivePolicy };
  }
}

function persistSensitivePolicy(policy: SensitivePolicyView): void {
  fs.mkdirSync(path.dirname(sensitivePolicyPath), { recursive: true });
  const tmp = `${sensitivePolicyPath}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify(
      {
        reauth_window_minutes: policy.reauth_window_minutes,
        require_2fa_override: policy.require_2fa_override,
        sensitive_actions: policy.sensitive_actions,
        updated_at_utc: policy.updated_at_utc
      },
      null,
      2
    )
  );
  fs.renameSync(tmp, sensitivePolicyPath);
}

export function readSensitivePolicy(): SensitivePolicyView {
  const policy = readSensitivePolicyStored();
  const sinceMs = Date.now() - 60 * 60 * 1000;
  const blocked = readSecurityEvents('1h').filter((row) => row.result === 'DENIED' && row.reason_code === 'REAUTH_REQUIRED').length;
  return {
    ...policy,
    blocked_missing_reauth_last_1h: blocked,
    expired_sessions: 0,
    source: 'control_plane',
    updated_at_utc: policy.updated_at_utc ?? new Date(sinceMs).toISOString()
  };
}

export function updateSensitivePolicy(input: { reauth_window_minutes: number; require_2fa_override: boolean }): SensitivePolicyView {
  const current = readSensitivePolicyStored();
  const next: SensitivePolicyView = {
    ...current,
    reauth_window_minutes: Math.max(1, Math.trunc(input.reauth_window_minutes)),
    require_2fa_override: Boolean(input.require_2fa_override),
    updated_at_utc: new Date().toISOString()
  };
  persistSensitivePolicy(next);
  return readSensitivePolicy();
}

export function readSecurityEvents(window: '15m' | '1h' | '24h'): SecurityEventView[] {
  const now = Date.now();
  const fromMs = now - parseWindowMillis(window);
  return readOperatorAuditEvents(2000)
    .filter((event) => {
      const ts = Date.parse(event.occurredAtUtc);
      return Number.isFinite(ts) && ts >= fromMs && ts <= now;
    })
    .filter((event) => /(rbac|access|auth|permission|role|reauth|override)/i.test(event.action))
    .map((event) => {
      const meta = (event.metadata ?? {}) as Record<string, unknown>;
      const attemptedAction = typeof meta.attempted_action === 'string' ? meta.attempted_action : event.action;
      const reasonCode = typeof meta.reason_code === 'string'
        ? meta.reason_code
        : typeof meta.reasonCode === 'string'
          ? meta.reasonCode
          : null;
      const resultRaw = typeof meta.result === 'string' ? meta.result.toUpperCase() : null;
      const result = resultRaw === 'DENIED' || resultRaw === 'ALLOWED' || resultRaw === 'UNKNOWN'
        ? resultRaw
        : normalizeResult(event.action, reasonCode);
      return {
        timestamp_utc: event.occurredAtUtc,
        user_id: typeof meta.user_id === 'string' ? meta.user_id : event.actorId,
        role: typeof meta.role === 'string' ? meta.role : null,
        attempted_action: attemptedAction,
        resource: typeof meta.resource === 'string' ? meta.resource : event.target,
        scope: typeof meta.scope === 'string' ? meta.scope : null,
        scope_id: typeof meta.scope_id === 'string' ? meta.scope_id : null,
        result,
        reason_code: reasonCode,
        correlation_id: typeof meta.correlation_id === 'string'
          ? meta.correlation_id
          : typeof meta.correlationId === 'string'
            ? meta.correlationId
            : null,
        trace_id: typeof meta.trace_id === 'string' ? meta.trace_id : null
      } satisfies SecurityEventView;
    })
    .sort((a, b) => Date.parse(b.timestamp_utc) - Date.parse(a.timestamp_utc));
}

