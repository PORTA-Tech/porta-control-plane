import { Request, Response, NextFunction } from 'express';

export type OperatorRole = 'viewer' | 'operator' | 'admin';

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
  { method: 'GET', path: /^\/v1\/rollout\/state$/, roles: roleSet('viewer', 'operator', 'admin') },
  { method: 'POST', path: /^\/v1\/rollout\/promote$/, roles: roleSet('operator') },
  { method: 'POST', path: /^\/v1\/rollout\/halt$/, roles: roleSet('operator') },
  { method: 'POST', path: /^\/v1\/rollout\/rollback$/, roles: roleSet('operator') },
  { method: 'POST', path: /^\/v1\/slo\/evaluate$/, roles: roleSet('operator') },
  { method: 'GET', path: /^\/v1\/audit\/events$/, roles: roleSet('admin') },
  { method: 'GET', path: /^\/v1\/audit\/rollout-events$/, roles: roleSet('admin') },
  { method: 'GET', path: /^\/v1\/audit\/outbox\/status$/, roles: roleSet('admin') },
  { method: 'POST', path: /^\/v1\/audit\/outbox\/dispatch$/, roles: roleSet('admin') }
];

const allowedRoles = roleSet('viewer', 'operator', 'admin');

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
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  if (!req.operatorRole || !policy.roles.has(req.operatorRole)) {
    res.status(403).json({ error: 'forbidden' });
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
