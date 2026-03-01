import { Router } from 'express';
import type { OperatorRequest } from '../middleware/auth.js';
import {
  listSecurityRoles,
  readSecurityEvents,
  readSecurityPermissionsMatrix,
  readSensitivePolicy,
  updateSensitivePolicy
} from '../../core/securityAccessStore.js';

export function createSecurityController(): Router {
  const router = Router();

  router.get('/roles', (_req, res) => {
    res.json(listSecurityRoles());
  });

  router.get('/permissions-matrix', (req, res) => {
    const matrix = readSecurityPermissionsMatrix();
    const role = (req as OperatorRequest).operatorRole ?? 'viewer';
    if (role === 'admin' || role === 'auditor') {
      res.json({
        ...matrix,
        visibility: 'full',
        scoped_role: null
      });
      return;
    }
    const scoped = matrix.rows.find((row) => row.role === role);
    res.json({
      rows: scoped ? [{ ...scoped, sensitive_actions: [] }] : [],
      source: matrix.source,
      updated_at_utc: matrix.updated_at_utc,
      visibility: 'restricted',
      scoped_role: role
    });
  });

  router.get('/sensitive-policy', (_req, res) => {
    res.json(readSensitivePolicy());
  });

  router.post('/sensitive-policy/update', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reauth = Number(body.reauth_window_minutes);
    const require2fa = Boolean(body.require_2fa_override);
    if (!Number.isFinite(reauth) || reauth < 1) {
      res.status(400).json({
        error_code: 'VALIDATION_ERROR',
        message: 'reauth_window_minutes must be >= 1.'
      });
      return;
    }
    const updated = updateSensitivePolicy({
      reauth_window_minutes: Math.max(1, Math.trunc(reauth)),
      require_2fa_override: require2fa
    });
    res.json(updated);
  });

  router.get('/events', (req, res) => {
    const windowRaw = typeof req.query.window === 'string' ? req.query.window : '1h';
    const window = windowRaw === '15m' || windowRaw === '24h' ? windowRaw : '1h';
    res.json(readSecurityEvents(window));
  });

  return router;
}
