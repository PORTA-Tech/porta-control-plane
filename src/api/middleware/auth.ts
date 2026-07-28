import { Request, Response, NextFunction } from 'express';
import { readAuthSession } from '../../core/authSessionStore.js';
import { incrementAuditMetric } from '../../core/policyGovernanceStore.js';

export type OperatorRole = 'viewer' | 'operator' | 'admin' | 'auditor' | 'developer' | 'agent';

export interface OperatorRequest extends Request {
  operatorId?: string;
  /**
   * The signed-in account, which is NOT operatorId. operatorId carries the session's
   * user_id; account ownership checks must compare against this field instead.
   * Only populated in session mode — header/operator-key auth has no account.
   */
  operatorAccountId?: string;
  operatorRole?: OperatorRole;
  authSessionToken?: string;
  authMode?: 'session' | 'header';
  reauthExpiresAtUtc?: string;
}

interface RoutePolicy {
  method: string;
  path: RegExp;
  roles: ReadonlySet<OperatorRole>;
  requiresRecentReauth?: boolean;
}

const roleSet = (...roles: OperatorRole[]): ReadonlySet<OperatorRole> => new Set(roles);

const routePolicies: RoutePolicy[] = [
  { method: 'POST', path: /^\/v1\/config\/submit$/, roles: roleSet('operator'), requiresRecentReauth: true },
  { method: 'GET', path: /^\/v1\/config\/current$/, roles: roleSet('operator', 'admin') },
  { method: 'GET', path: /^\/v1\/config\/ledger$/, roles: roleSet('operator', 'admin') },
  { method: 'GET', path: /^\/v1\/config\/integrity-active$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'GET', path: /^\/v1\/config\/diff-preview$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'GET', path: /^\/v1\/rollout\/state$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'GET', path: /^\/v1\/rollout\/dry-run$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'GET', path: /^\/v1\/rollout\/evaluate$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'GET', path: /^\/v1\/rollout\/validation-gates$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'POST', path: /^\/v1\/rollout\/validation-gates$/, roles: roleSet('operator', 'admin') },
  { method: 'GET', path: /^\/v1\/rollout\/evidence-pack$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'POST', path: /^\/v1\/rollout\/promote$/, roles: roleSet('operator'), requiresRecentReauth: true },
  { method: 'POST', path: /^\/v1\/rollout\/halt$/, roles: roleSet('operator'), requiresRecentReauth: true },
  { method: 'POST', path: /^\/v1\/rollout\/rollback$/, roles: roleSet('operator'), requiresRecentReauth: true },
  { method: 'POST', path: /^\/v1\/slo\/evaluate$/, roles: roleSet('operator') },
  { method: 'GET', path: /^\/v1\/nodes\/snapshot$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'GET', path: /^\/v1\/me$/, roles: roleSet('viewer', 'developer', 'operator', 'admin', 'auditor') },
  { method: 'PATCH', path: /^\/v1\/me\/profile$/, roles: roleSet('viewer', 'developer', 'operator', 'admin', 'auditor') },
  { method: 'GET', path: /^\/v1\/me\/organizations$/, roles: roleSet('viewer', 'developer', 'operator', 'admin', 'auditor') },
  { method: 'GET', path: /^\/v1\/me\/devices$/, roles: roleSet('viewer', 'developer', 'operator', 'admin', 'auditor') },
  { method: 'POST', path: /^\/v1\/me\/devices\/[^/]+\/revoke$/, roles: roleSet('viewer', 'developer', 'operator', 'admin', 'auditor') },
  { method: 'POST', path: /^\/v1\/me\/devices\/[^/]+\/unlink$/, roles: roleSet('viewer', 'developer', 'operator', 'admin', 'auditor') },
  { method: 'GET', path: /^\/v1\/admin\/accounts\/[^/]+$/, roles: roleSet('admin') },
  { method: 'GET', path: /^\/v1\/admin\/accounts\/[^/]+\/devices$/, roles: roleSet('admin') },
  { method: 'POST', path: /^\/v1\/admin\/accounts\/[^/]+\/devices\/[^/]+\/revoke$/, roles: roleSet('admin') },
  { method: 'POST', path: /^\/v1\/admin\/accounts\/[^/]+\/devices\/[^/]+\/unlink$/, roles: roleSet('admin') },
  { method: 'GET', path: /^\/v1\/admin\/organizations\/[^/]+$/, roles: roleSet('admin') },
  { method: 'PATCH', path: /^\/v1\/admin\/accounts\/primary-email$/, roles: roleSet('admin') },
  { method: 'GET', path: /^\/v1\/machines\/summary$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'GET', path: /^\/v1\/machines\/[^/]+$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'GET', path: /^\/v1\/machines\/[^/]+\/actions$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'GET', path: /^\/v1\/machines\/[^/]+\/uptime$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'GET', path: /^\/v1\/machines\/[^/]+\/daily-stats$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'GET', path: /^\/v1\/digest\/log$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'GET', path: /^\/v1\/actions\/recent$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'GET', path: /^\/v1\/growth\/summary$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'GET', path: /^\/v1\/growth\/series$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'GET', path: /^\/v1\/growth\/cohorts$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'GET', path: /^\/v1\/growth\/users\/[^/]+\/journey$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'GET', path: /^\/v1\/cohorts\/evaluate$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'POST', path: /^\/v1\/experiments\/evaluate$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'GET', path: /^\/v1\/experiments\/events$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'POST', path: /^\/v1\/experiments\/[a-z0-9-]+\/stop$/, roles: roleSet('operator', 'admin') },
  { method: 'GET', path: /^\/v1\/adapter\/controls$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'POST', path: /^\/v1\/adapter\/controls$/, roles: roleSet('operator') },
  { method: 'GET', path: /^\/v1\/adapter\/observability$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'GET', path: /^\/v1\/adapter\/replay-log$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'GET', path: /^\/v1\/adapter\/promotion-path$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'POST', path: /^\/v1\/adapter\/promotion-path$/, roles: roleSet('operator') },
  { method: 'GET', path: /^\/v1\/audit\/events$/, roles: roleSet('admin') },
  { method: 'GET', path: /^\/v1\/audit\/rollout-events$/, roles: roleSet('admin') },
  { method: 'GET', path: /^\/v1\/audit\/ledger-view$/, roles: roleSet('admin') },
  { method: 'GET', path: /^\/v1\/audit\/outbox\/status$/, roles: roleSet('admin') },
  { method: 'POST', path: /^\/v1\/audit\/outbox\/dispatch$/, roles: roleSet('admin') },
  { method: 'GET', path: /^\/v1\/audit\/decision-traces$/, roles: roleSet('auditor', 'admin') },
  { method: 'POST', path: /^\/v1\/audit\/replay\/verify$/, roles: roleSet('auditor', 'admin') },
  { method: 'GET', path: /^\/v1\/audit\/metrics$/, roles: roleSet('auditor', 'admin', 'operator') },
  { method: 'GET', path: /^\/v1\/audit\/alerts$/, roles: roleSet('auditor', 'admin', 'operator') },
  { method: 'POST', path: /^\/v1\/audit\/alerts\/[a-z0-9]+\/resolve$/, roles: roleSet('admin', 'operator') },
  { method: 'POST', path: /^\/v1\/policy\/evaluate$/, roles: roleSet('operator', 'admin') },
  { method: 'GET', path: /^\/v1\/policy\/state\/[a-z0-9._-]+\/[a-z0-9._-]+$/, roles: roleSet('operator', 'admin', 'auditor') },
  { method: 'GET', path: /^\/v1\/security\/roles$/, roles: roleSet('viewer', 'developer', 'operator', 'admin', 'auditor') },
  { method: 'GET', path: /^\/v1\/security\/permissions-matrix$/, roles: roleSet('viewer', 'developer', 'operator', 'admin', 'auditor') },
  { method: 'GET', path: /^\/v1\/security\/sensitive-policy$/, roles: roleSet('operator', 'admin', 'auditor') },
  { method: 'POST', path: /^\/v1\/security\/sensitive-policy\/update$/, roles: roleSet('admin'), requiresRecentReauth: true },
  { method: 'GET', path: /^\/v1\/security\/events$/, roles: roleSet('operator', 'admin', 'auditor') },
  { method: 'GET', path: /^\/v1\/rbac\/assignments$/, roles: roleSet('operator', 'admin', 'auditor') },
  { method: 'POST', path: /^\/v1\/rbac\/assign$/, roles: roleSet('admin'), requiresRecentReauth: true },
  { method: 'POST', path: /^\/v1\/rbac\/revoke$/, roles: roleSet('admin'), requiresRecentReauth: true },
  { method: 'GET', path: /^\/v1\/rbac\/effective-permissions$/, roles: roleSet('viewer', 'developer', 'operator', 'admin', 'auditor') },
  { method: 'GET', path: /^\/v1\/system\/health$/, roles: roleSet('viewer', 'developer', 'operator', 'admin', 'auditor') },
  { method: 'POST', path: /^\/v1\/system\/ui-metrics$/, roles: roleSet('viewer', 'developer', 'operator', 'admin', 'auditor') }
];

const allowedRoles = roleSet('viewer', 'operator', 'admin', 'auditor', 'developer', 'agent');

function parseBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const raw = header.trim();
  if (!raw.toLowerCase().startsWith('bearer ')) return null;
  const token = raw.slice('bearer '.length).trim();
  return token.length > 0 ? token : null;
}

export async function requireAuthenticatedOperator(req: OperatorRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const bearerToken = parseBearerToken(req.header('authorization'));
    if (bearerToken) {
      const session = await readAuthSession(bearerToken);
      if (!session) {
        res.status(401).json({ error: 'unauthorized', error_code: 'SESSION_EXPIRED' });
        return;
      }
      req.operatorId = session.user_id;
      req.operatorAccountId = session.account_id;
      req.operatorRole = session.role;
      req.authSessionToken = bearerToken;
      req.authMode = 'session';
      req.reauthExpiresAtUtc = session.reauth_expires_at_utc;
      next();
      return;
    }

    const operatorKey = process.env.PORTA_OPERATOR_KEY;
    if (!operatorKey) {
      // No secret configured — header-mode is disabled entirely.
      res.status(401).json({ error: 'unauthorized', error_code: 'OPERATOR_KEY_NOT_CONFIGURED' });
      return;
    }

    const operatorId = req.header('x-operator-id');
    const operatorRole = req.header('x-operator-role')?.toLowerCase() as OperatorRole | undefined;
    const providedKey = req.header('x-operator-key');

    if (!operatorId || !operatorRole || !allowedRoles.has(operatorRole)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    if (!providedKey || providedKey !== operatorKey) {
      res.status(401).json({ error: 'unauthorized', error_code: 'INVALID_OPERATOR_KEY' });
      return;
    }

    req.operatorId = operatorId;
    req.operatorRole = operatorRole;
    req.authMode = 'header';
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Session-only authentication for routes that act on a specific account.
 *
 * Deliberately does not fall back to the x-operator-key header the way
 * requireAuthenticatedOperator does. That key is a shared secret baked into the
 * operations console bundle at build time and carries no account, so it cannot
 * satisfy an account-ownership check. Nothing in the console calls these routes.
 */
export async function requireAccountSession(req: OperatorRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const bearerToken = parseBearerToken(req.header('authorization'));
    if (!bearerToken) {
      res.status(401).json({ error: 'unauthorized', error_code: 'SESSION_REQUIRED' });
      return;
    }

    const session = await readAuthSession(bearerToken);
    if (!session) {
      res.status(401).json({ error: 'unauthorized', error_code: 'SESSION_EXPIRED' });
      return;
    }

    req.operatorId = session.user_id;
    req.operatorAccountId = session.account_id;
    req.operatorRole = session.role;
    req.authSessionToken = bearerToken;
    req.authMode = 'session';
    req.reauthExpiresAtUtc = session.reauth_expires_at_utc;
    next();
  } catch (error) {
    next(error);
  }
}

function resolvePolicy(req: Request): RoutePolicy | undefined {
  const method = req.method.toUpperCase();
  const fullPath = `${req.baseUrl}${req.path}`;
  return routePolicies.find((policy) => policy.method === method && policy.path.test(fullPath));
}

export function enforceRbacPolicy(req: OperatorRequest, res: Response, next: NextFunction): void {
  const policy = resolvePolicy(req);
  if (!policy) {
    incrementAuditMetric('audit_access_denied_total', 1, { reason: 'route_policy_missing' });
    res.status(403).json({
      error_code: 'RBAC_DENIED',
      required_role: 'operator',
      user_role: req.operatorRole ?? 'unknown',
      message: 'You do not have permission to execute this action.'
    });
    return;
  }

  if (!req.operatorRole || !policy.roles.has(req.operatorRole)) {
    incrementAuditMetric('audit_access_denied_total', 1, { reason: 'role_denied' });
    res.status(403).json({
      error_code: 'RBAC_DENIED',
      required_role: [...policy.roles][0],
      user_role: req.operatorRole ?? 'unknown',
      message: 'You do not have permission to execute this action.'
    });
    return;
  }

  if (policy.requiresRecentReauth && req.authMode === 'session') {
    const reauthExpiresMs = req.reauthExpiresAtUtc ? Date.parse(req.reauthExpiresAtUtc) : NaN;
    if (!Number.isFinite(reauthExpiresMs) || reauthExpiresMs <= Date.now()) {
      incrementAuditMetric('audit_access_denied_total', 1, { reason: 'reauth_required' });
      res.status(403).json({
        error_code: 'REAUTH_REQUIRED',
        required_role: [...policy.roles][0],
        user_role: req.operatorRole ?? 'unknown',
        message: 'Re-authentication is required for this sensitive action.'
      });
      return;
    }
  }

  next();
}

export function getRbacPolicies(): RoutePolicy[] {
  return [...routePolicies];
}

export function requireAdmin(req: OperatorRequest, res: Response, next: NextFunction): void {
  if (req.operatorRole !== 'admin') {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
}
