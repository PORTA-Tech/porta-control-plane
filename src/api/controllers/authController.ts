import { Router } from 'express';
import {
  authenticateUser,
  issueAuthSession,
  listAuthUsers,
  readAuthAccessHelp,
  readAuthSession,
  registerAuthUser,
  refreshReauth,
  revokeAuthSession
} from '../../core/authSessionStore.js';

function parseBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const value = header.trim();
  if (!value.toLowerCase().startsWith('bearer ')) return null;
  const token = value.slice('bearer '.length).trim();
  return token.length > 0 ? token : null;
}

export function createAuthController(): Router {
  const router = Router();

  router.post('/login', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const userId = typeof body.user_id === 'string'
      ? body.user_id
      : typeof body.username === 'string'
        ? body.username
        : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!userId.trim() || !password) {
      res.status(400).json({ error_code: 'VALIDATION_ERROR', message: 'user_id and password are required.' });
      return;
    }
    const user = authenticateUser(userId.trim(), password);
    if (!user) {
      res.status(401).json({ error_code: 'INVALID_CREDENTIALS', message: 'Invalid username or password.' });
      return;
    }

    const issued = issueAuthSession(user);
    res.json({
      access_token: issued.access_token,
      token_type: 'Bearer',
      user: {
        user_id: issued.session.user_id,
        role: issued.session.role,
        display_name: issued.session.display_name
      },
      session_expires_at_utc: issued.session.expires_at_utc,
      reauth_expires_at_utc: issued.session.reauth_expires_at_utc
    });
  });

  router.get('/me', (req, res) => {
    const token = parseBearerToken(req.header('authorization'));
    if (!token) {
      res.status(401).json({ error_code: 'UNAUTHORIZED', message: 'Bearer token is required.' });
      return;
    }
    const session = readAuthSession(token);
    if (!session) {
      res.status(401).json({ error_code: 'SESSION_EXPIRED', message: 'Session expired or invalid.' });
      return;
    }
    res.json({
      user_id: session.user_id,
      role: session.role,
      display_name: session.display_name,
      issued_at_utc: session.issued_at_utc,
      session_expires_at_utc: session.expires_at_utc,
      reauth_expires_at_utc: session.reauth_expires_at_utc
    });
  });

  router.post('/logout', (req, res) => {
    const token = parseBearerToken(req.header('authorization'));
    if (token) {
      revokeAuthSession(token);
    }
    res.json({ ok: true });
  });

  router.post('/reauth', (req, res) => {
    const token = parseBearerToken(req.header('authorization'));
    if (!token) {
      res.status(401).json({ error_code: 'UNAUTHORIZED', message: 'Bearer token is required.' });
      return;
    }
    const session = readAuthSession(token);
    if (!session) {
      res.status(401).json({ error_code: 'SESSION_EXPIRED', message: 'Session expired or invalid.' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password) {
      res.status(400).json({ error_code: 'VALIDATION_ERROR', message: 'password is required for re-auth.' });
      return;
    }
    const valid = authenticateUser(session.user_id, password);
    if (!valid) {
      res.status(401).json({ error_code: 'INVALID_CREDENTIALS', message: 'Invalid credentials.' });
      return;
    }
    const refreshed = refreshReauth(token);
    if (!refreshed) {
      res.status(401).json({ error_code: 'SESSION_EXPIRED', message: 'Session expired or invalid.' });
      return;
    }
    res.json({
      ok: true,
      reauth_expires_at_utc: refreshed.reauth_expires_at_utc
    });
  });

  router.get('/users', (_req, res) => {
    res.json(listAuthUsers());
  });

  router.get('/access-help', (_req, res) => {
    res.json(readAuthAccessHelp());
  });

  router.post('/register', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const userId = typeof body.user_id === 'string' ? body.user_id : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const displayName = typeof body.display_name === 'string' ? body.display_name : userId;
    const role = typeof body.role === 'string' ? body.role : 'developer';
    if (!userId.trim() || !password || !displayName.trim()) {
      res.status(400).json({
        error_code: 'VALIDATION_ERROR',
        message: 'user_id, display_name and password are required.'
      });
      return;
    }
    const allowedRoles = new Set(['viewer', 'developer', 'auditor', 'operator', 'admin']);
    if (!allowedRoles.has(role)) {
      res.status(400).json({
        error_code: 'VALIDATION_ERROR',
        message: 'Unsupported role.'
      });
      return;
    }
    const created = registerAuthUser({
      user_id: userId.trim(),
      password,
      display_name: displayName.trim(),
      role: role as 'viewer' | 'developer' | 'auditor' | 'operator' | 'admin'
    });
    if (!created.ok) {
      const status = created.error_code === 'USER_EXISTS' ? 409 : created.error_code === 'SIGNUP_DISABLED' || created.error_code === 'ADMIN_SIGNUP_DISABLED' ? 403 : 400;
      res.status(status).json({
        error_code: created.error_code,
        message: created.message
      });
      return;
    }
    res.status(201).json({
      ok: true,
      user: created.user
    });
  });

  return router;
}
