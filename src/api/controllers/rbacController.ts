import { Router } from 'express';
import type { OperatorRequest } from '../middleware/auth.js';
import { appendOperatorAuditEvent } from '../../core/operatorAudit.js';
import { assignRbacRole, listRbacAssignments, revokeRbacRole, type RbacRole, type RbacScope } from '../../core/rbacStore.js';
import { readPermissionsForRole } from '../../core/securityAccessStore.js';
import { resolveAuthUserRole } from '../../core/authSessionStore.js';

const validRoles = new Set<RbacRole>(['admin', 'operator', 'auditor', 'developer', 'viewer']);
const validScopes = new Set<RbacScope>(['fleet', 'agent']);

export function createRbacController(): Router {
  const router = Router();

  router.get('/assignments', (_req, res) => {
    res.json(listRbacAssignments(false));
  });

  router.post('/assign', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const userId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
    const role = typeof body.role === 'string' ? body.role : '';
    const scope = typeof body.scope === 'string' ? body.scope : '';
    const scopeId = typeof body.scope_id === 'string' ? body.scope_id.trim() : '';
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    const expiresAt = typeof body.expires_at === 'string' ? body.expires_at : undefined;
    if (!userId || !scopeId || !validRoles.has(role as RbacRole) || !validScopes.has(scope as RbacScope)) {
      res.status(400).json({
        error_code: 'VALIDATION_ERROR',
        message: 'user_id, role, scope and scope_id are required.'
      });
      return;
    }

    const actorId = (req as OperatorRequest).operatorId ?? 'operator-unknown';
    const assignment = assignRbacRole({
      user_id: userId,
      role: role as RbacRole,
      scope: scope as RbacScope,
      scope_id: scopeId,
      assigned_by: actorId,
      ...(reason ? { reason } : {}),
      ...(expiresAt ? { expires_at: expiresAt } : {})
    });
    appendOperatorAuditEvent(actorId, 'rbac.assign', 'rbac.assignment', {
      user_id: userId,
      role,
      scope,
      scope_id: scopeId,
      result: 'ALLOWED'
    });
    res.json({ ok: true, assignment });
  });

  router.post('/revoke', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const userId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
    const role = typeof body.role === 'string' ? body.role : '';
    const scope = typeof body.scope === 'string' ? body.scope : '';
    const scopeId = typeof body.scope_id === 'string' ? body.scope_id.trim() : '';
    if (!userId || !scopeId || !validRoles.has(role as RbacRole) || !validScopes.has(scope as RbacScope)) {
      res.status(400).json({
        error_code: 'VALIDATION_ERROR',
        message: 'user_id, role, scope and scope_id are required.'
      });
      return;
    }
    const actorId = (req as OperatorRequest).operatorId ?? 'operator-unknown';
    const removed = revokeRbacRole({
      user_id: userId,
      role: role as RbacRole,
      scope: scope as RbacScope,
      scope_id: scopeId
    });
    appendOperatorAuditEvent(actorId, 'rbac.revoke', 'rbac.assignment', {
      user_id: userId,
      role,
      scope,
      scope_id: scopeId,
      result: removed > 0 ? 'ALLOWED' : 'UNKNOWN'
    });
    res.json({ ok: true, removed });
  });

  router.get('/effective-permissions', (req, res) => {
    const caller = req as OperatorRequest;
    const requested = typeof req.query.user_id === 'string' && req.query.user_id.trim().length > 0
      ? req.query.user_id.trim()
      : caller.operatorId ?? '';
    if (!requested) {
      res.status(400).json({
        error_code: 'VALIDATION_ERROR',
        message: 'user_id is required.'
      });
      return;
    }
    if (caller.operatorRole !== 'admin' && caller.operatorId !== requested) {
      res.status(403).json({
        error_code: 'RBAC_DENIED',
        message: 'Only admins can inspect permissions for other users.'
      });
      return;
    }

    const role = resolveAuthUserRole(requested) ?? 'viewer';
    res.json({
      user_id: requested,
      role,
      permissions: readPermissionsForRole(role),
      source: 'control_plane_rbac'
    });
  });

  return router;
}

