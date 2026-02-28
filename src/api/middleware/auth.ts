import { Request, Response, NextFunction } from 'express';
import { incrementAuditMetric } from '../../core/policyGovernanceStore.js';

export type OperatorRole = 'viewer' | 'operator' | 'admin' | 'auditor' | 'developer' | 'agent';

export interface OperatorRequest extends Request {
  operatorId?: string;
  operatorRole?: OperatorRole;
}

interface RoutePolicy {
  method: string;
  path: RegExp;
  roles: ReadonlySet<OperatorRole>;
}

const roleSet = (...roles: OperatorRole[]): ReadonlySet<OperatorRole> => new Set(roles);

const routePolicies: RoutePolicy[] = [
  { method: 'POST', path: /^\/v1\/config\/submit$/, roles: roleSet('operator') },
  { method: 'GET', path: /^\/v1\/config\/current$/, roles: roleSet('operator', 'admin') },
  { method: 'GET', path: /^\/v1\/config\/ledger$/, roles: roleSet('operator', 'admin') },
  { method: 'GET', path: /^\/v1\/config\/integrity-active$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'GET', path: /^\/v1\/config\/diff-preview$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'GET', path: /^\/v1\/rollout\/state$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'GET', path: /^\/v1\/rollout\/dry-run$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'GET', path: /^\/v1\/rollout\/evaluate$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'GET', path: /^\/v1\/rollout\/evidence-pack$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'POST', path: /^\/v1\/rollout\/promote$/, roles: roleSet('operator') },
  { method: 'POST', path: /^\/v1\/rollout\/halt$/, roles: roleSet('operator') },
  { method: 'POST', path: /^\/v1\/rollout\/rollback$/, roles: roleSet('operator') },
  { method: 'POST', path: /^\/v1\/slo\/evaluate$/, roles: roleSet('operator') },
  { method: 'GET', path: /^\/v1\/nodes\/snapshot$/, roles: roleSet('viewer', 'operator', 'admin') },
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
  { method: 'GET', path: /^\/v1\/policy\/state\/[a-z0-9._-]+\/[a-z0-9._-]+$/, roles: roleSet('operator', 'admin', 'auditor') }
];

const allowedRoles = roleSet('viewer', 'operator', 'admin', 'auditor', 'developer', 'agent');

export function requireAuthenticatedOperator(req: OperatorRequest, res: Response, next: NextFunction): void {
  const operatorId = req.header('x-operator-id');
  const operatorRole = req.header('x-operator-role')?.toLowerCase() as OperatorRole | undefined;

  if (!operatorId || !operatorRole || !allowedRoles.has(operatorRole)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  req.operatorId = operatorId;
  req.operatorRole = operatorRole;
  next();
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
