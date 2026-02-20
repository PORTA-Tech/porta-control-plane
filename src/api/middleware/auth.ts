import { Request, Response, NextFunction } from 'express';

export interface OperatorRequest extends Request {
  operatorId?: string;
  operatorRole?: string;
}

const allowedRoles = new Set(['viewer', 'operator', 'admin']);

export function requireOperator(req: OperatorRequest, res: Response, next: NextFunction): void {
  const operatorId = req.header('x-operator-id');
  const operatorRole = req.header('x-operator-role')?.toLowerCase();

  if (!operatorId || !operatorRole || !allowedRoles.has(operatorRole)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  req.operatorId = operatorId;
  req.operatorRole = operatorRole;
  next();
}

export function requireAdmin(req: OperatorRequest, res: Response, next: NextFunction): void {
  if (req.operatorRole !== 'admin') {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
}
