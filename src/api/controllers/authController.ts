import { Request, Response, Router } from 'express';
import {
  authenticateUser,
  hasAuthUser,
  issueAuthSession,
  listAuthUsers,
  readAuthAccessHelp,
  readAuthSession,
  resetAuthUserPasswordWithCode,
  registerAuthUser,
  refreshReauth,
  updateAuthUserPassword,
  updateAuthUserProfile,
  revokeAuthSession
} from '../../core/authSessionStore.js';
import {
  generatePasswordResetCode,
  generateSignupCode,
  listActiveAccessCodes
} from '../../core/authAccessCodeStore.js';

function parseBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const value = header.trim();
  if (!value.toLowerCase().startsWith('bearer ')) return null;
  const token = value.slice('bearer '.length).trim();
  return token.length > 0 ? token : null;
}

function readSessionOrReject(req: Request, res: Response) {
  const token = parseBearerToken(req.header('authorization'));
  if (!token) {
    res.status(401).json({ error_code: 'UNAUTHORIZED', message: 'Bearer token is required.' });
    return null;
  }
  const session = readAuthSession(token);
  if (!session) {
    res.status(401).json({ error_code: 'SESSION_EXPIRED', message: 'Session expired or invalid.' });
    return null;
  }
  return session;
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
      const exists = hasAuthUser(userId.trim());
      res.status(401).json({
        error_code: exists ? 'INVALID_CREDENTIALS' : 'USER_NOT_FOUND',
        message: exists ? 'Invalid username or password.' : 'Account not found. Create an account on this control-plane node.'
      });
      return;
    }

    const issued = issueAuthSession(user);
    res.json({
      access_token: issued.access_token,
      token_type: 'Bearer',
      user: {
        user_id: issued.session.user_id,
        role: issued.session.role,
        display_name: issued.session.display_name,
        avatar_url: issued.session.avatar_url ?? null
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
      avatar_url: session.avatar_url ?? null,
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
    const signupCode = typeof body.signup_code === 'string' ? body.signup_code : '';
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
      role: role as 'viewer' | 'developer' | 'auditor' | 'operator' | 'admin',
      signup_code: signupCode
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

  router.post('/forgot-password/reset', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const userId = typeof body.user_id === 'string' ? body.user_id : '';
    const resetCode = typeof body.reset_code === 'string' ? body.reset_code : '';
    const newPassword = typeof body.new_password === 'string' ? body.new_password : '';
    const updated = resetAuthUserPasswordWithCode({
      user_id: userId,
      reset_code: resetCode,
      new_password: newPassword
    });
    if (!updated.ok) {
      const status = updated.error_code === 'USER_NOT_FOUND' ? 404 : 400;
      res.status(status).json({ error_code: updated.error_code, message: updated.message });
      return;
    }
    res.json({ ok: true });
  });

  router.patch('/profile', (req, res) => {
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
    const displayName = typeof body.display_name === 'string' ? body.display_name : undefined;
    const avatarUrl = body.avatar_url === null
      ? null
      : typeof body.avatar_url === 'string'
        ? body.avatar_url
        : undefined;
    const updated = updateAuthUserProfile({
      user_id: session.user_id,
      ...(displayName !== undefined ? { display_name: displayName } : {}),
      ...(avatarUrl !== undefined ? { avatar_url: avatarUrl } : {})
    });
    if (!updated.ok) {
      res.status(400).json({ error_code: updated.error_code, message: updated.message });
      return;
    }
    res.json({
      ok: true,
      user: updated.user
    });
  });

  router.post('/change-password', (req, res) => {
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
    const currentPassword = typeof body.current_password === 'string' ? body.current_password : '';
    const newPassword = typeof body.new_password === 'string' ? body.new_password : '';
    if (!currentPassword || !newPassword) {
      res.status(400).json({
        error_code: 'VALIDATION_ERROR',
        message: 'current_password and new_password are required.'
      });
      return;
    }
    const changed = updateAuthUserPassword({
      user_id: session.user_id,
      current_password: currentPassword,
      new_password: newPassword
    });
    if (!changed.ok) {
      const status = changed.error_code === 'INVALID_CREDENTIALS' ? 401 : 400;
      res.status(status).json({ error_code: changed.error_code, message: changed.message });
      return;
    }
    res.json({ ok: true });
  });

  router.post('/admin/signup-code', (req, res) => {
    const session = readSessionOrReject(req, res);
    if (!session) return;
    if (session.role !== 'admin') {
      res.status(403).json({ error_code: 'RBAC_DENIED', message: 'Admin role required.' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ttlRaw = Number(body.ttl_minutes);
    const ttl = Number.isFinite(ttlRaw) ? Math.max(5, Math.min(120, Math.trunc(ttlRaw))) : undefined;
    const created = generateSignupCode(session.user_id, ttl);
    res.status(201).json({
      ok: true,
      code: created.code,
      expires_at_utc: created.expires_at_utc
    });
  });

  router.post('/admin/password-reset-code', (req, res) => {
    const session = readSessionOrReject(req, res);
    if (!session) return;
    if (session.role !== 'admin') {
      res.status(403).json({ error_code: 'RBAC_DENIED', message: 'Admin role required.' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const userId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
    if (!userId) {
      res.status(400).json({ error_code: 'VALIDATION_ERROR', message: 'user_id is required.' });
      return;
    }
    const ttlRaw = Number(body.ttl_minutes);
    const ttl = Number.isFinite(ttlRaw) ? Math.max(5, Math.min(120, Math.trunc(ttlRaw))) : undefined;
    const created = generatePasswordResetCode(session.user_id, userId, ttl);
    res.status(201).json({
      ok: true,
      user_id: userId,
      code: created.code,
      expires_at_utc: created.expires_at_utc
    });
  });

  router.get('/admin/codes', (req, res) => {
    const session = readSessionOrReject(req, res);
    if (!session) return;
    if (session.role !== 'admin') {
      res.status(403).json({ error_code: 'RBAC_DENIED', message: 'Admin role required.' });
      return;
    }
    const typeRaw = typeof req.query.type === 'string' ? req.query.type : 'all';
    const type = typeRaw === 'signup' || typeRaw === 'password_reset' ? typeRaw : 'all';
    res.json(listActiveAccessCodes(type));
  });

  return router;
}
