import { NextFunction, Request, Response, Router } from 'express';
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
import { materializeAuthUserIdentity } from '../../core/identityProfileService.js';
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

async function readSessionOrReject(req: Request, res: Response) {
  const token = parseBearerToken(req.header('authorization'));
  if (!token) {
    res.status(401).json({ error_code: 'UNAUTHORIZED', message: 'Bearer token is required.' });
    return null;
  }
  const session = await readAuthSession(token);
  if (!session) {
    res.status(401).json({ error_code: 'SESSION_EXPIRED', message: 'Session expired or invalid.' });
    return null;
  }
  return session;
}

export function createAuthController(): Router {
  const router = Router();

  router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
    try {
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
      const user = await authenticateUser(userId.trim(), password);
      if (!user) {
        const exists = await hasAuthUser(userId.trim());
        res.status(401).json({
          error_code: exists ? 'INVALID_CREDENTIALS' : 'USER_NOT_FOUND',
          message: exists ? 'Invalid username or password.' : 'Account not found. Create an account on this control-plane node.'
        });
        return;
      }

      const materialized = await materializeAuthUserIdentity(user.user_id);
      if (!materialized) {
        res.status(500).json({
          error_code: 'ACCOUNT_PROFILE_INIT_FAILED',
          message: 'Account profile could not be prepared for this sign-in.'
        });
        return;
      }

      const issued = await issueAuthSession(user, { account_id: materialized.account.accountId });
      res.json({
        access_token: issued.access_token,
        token_type: 'Bearer',
        user: {
          account_id: materialized.account.accountId,
          user_id: issued.session.user_id,
          role: issued.session.role,
          display_name: issued.session.display_name,
          avatar_url: issued.session.avatar_url ?? null,
          auth_provider: issued.session.auth_provider ?? null
        },
        session_expires_at_utc: issued.session.expires_at_utc,
        reauth_expires_at_utc: issued.session.reauth_expires_at_utc
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/me', async (req, res, next) => {
    try {
      const token = parseBearerToken(req.header('authorization'));
      if (!token) {
        res.status(401).json({ error_code: 'UNAUTHORIZED', message: 'Bearer token is required.' });
        return;
      }
      const session = await readAuthSession(token);
      if (!session) {
        res.status(401).json({ error_code: 'SESSION_EXPIRED', message: 'Session expired or invalid.' });
        return;
      }
      res.json({
        account_id: session.account_id,
        user_id: session.user_id,
        role: session.role,
        display_name: session.display_name,
        avatar_url: session.avatar_url ?? null,
        auth_provider: session.auth_provider ?? null,
        issued_at_utc: session.issued_at_utc,
        session_expires_at_utc: session.expires_at_utc,
        reauth_expires_at_utc: session.reauth_expires_at_utc
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      const token = parseBearerToken(req.header('authorization'));
      if (token) {
        await revokeAuthSession(token);
      }
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/reauth', async (req, res, next) => {
    try {
      const token = parseBearerToken(req.header('authorization'));
      if (!token) {
        res.status(401).json({ error_code: 'UNAUTHORIZED', message: 'Bearer token is required.' });
        return;
      }
      const session = await readAuthSession(token);
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
      const valid = await authenticateUser(session.user_id, password);
      if (!valid) {
        res.status(401).json({ error_code: 'INVALID_CREDENTIALS', message: 'Invalid credentials.' });
        return;
      }
      const refreshed = await refreshReauth(token);
      if (!refreshed) {
        res.status(401).json({ error_code: 'SESSION_EXPIRED', message: 'Session expired or invalid.' });
        return;
      }
      res.json({
        ok: true,
        reauth_expires_at_utc: refreshed.reauth_expires_at_utc
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/users', async (_req, res, next) => {
    try {
      res.json(await listAuthUsers());
    } catch (error) {
      next(error);
    }
  });

  router.get('/access-help', (_req, res) => {
    res.json(readAuthAccessHelp());
  });

  router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
    try {
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
      const created = await registerAuthUser({
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

      const materialized = await materializeAuthUserIdentity(created.user.user_id);
      if (!materialized) {
        res.status(500).json({
          error_code: 'ACCOUNT_PROFILE_INIT_FAILED',
          message: 'Account was created, but the account profile could not be prepared.'
        });
        return;
      }

      res.status(201).json({
        ok: true,
        user: {
          ...created.user,
          account_id: materialized.account.accountId
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/forgot-password/reset', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const userId = typeof body.user_id === 'string' ? body.user_id : '';
      const resetCode = typeof body.reset_code === 'string' ? body.reset_code : '';
      const newPassword = typeof body.new_password === 'string' ? body.new_password : '';
      const updated = await resetAuthUserPasswordWithCode({
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
    } catch (error) {
      next(error);
    }
  });

  router.patch('/profile', async (req, res, next) => {
    try {
      const token = parseBearerToken(req.header('authorization'));
      if (!token) {
        res.status(401).json({ error_code: 'UNAUTHORIZED', message: 'Bearer token is required.' });
        return;
      }
      const session = await readAuthSession(token);
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
      const updated = await updateAuthUserProfile({
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
    } catch (error) {
      next(error);
    }
  });

  router.post('/change-password', async (req, res, next) => {
    try {
      const token = parseBearerToken(req.header('authorization'));
      if (!token) {
        res.status(401).json({ error_code: 'UNAUTHORIZED', message: 'Bearer token is required.' });
        return;
      }
      const session = await readAuthSession(token);
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
      const changed = await updateAuthUserPassword({
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
    } catch (error) {
      next(error);
    }
  });

  router.post('/admin/signup-code', async (req, res, next) => {
    try {
      const session = await readSessionOrReject(req, res);
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
    } catch (error) {
      next(error);
    }
  });

  router.post('/admin/password-reset-code', async (req, res, next) => {
    try {
      const session = await readSessionOrReject(req, res);
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
    } catch (error) {
      next(error);
    }
  });

  router.get('/admin/codes', async (req, res, next) => {
    try {
      const session = await readSessionOrReject(req, res);
      if (!session) return;
      if (session.role !== 'admin') {
        res.status(403).json({ error_code: 'RBAC_DENIED', message: 'Admin role required.' });
        return;
      }
      const typeRaw = typeof req.query.type === 'string' ? req.query.type : 'all';
      const type = typeRaw === 'signup' || typeRaw === 'password_reset' ? typeRaw : 'all';
      res.json(listActiveAccessCodes(type));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
