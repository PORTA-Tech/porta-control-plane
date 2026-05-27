import { Request, Response, Router } from 'express';
import { updateAuthUserProfile } from '../../core/authSessionStore.js';
import {
  buildAdminAccountView,
  buildAdminOrganizationView,
  buildMeProfileView,
  ensureAccountProfileForAuthUser,
  listDevicesForAccount,
  listDevicesForAuthUser,
  listOrganizationsForAuthUser,
  revokeDeviceForAccount,
  unlinkDeviceForAccount
} from '../../core/identityProfileService.js';
import { getAccountProfileByPrimaryEmail, upsertAccountProfile } from '../../store/accountStore.js';
import type { OperatorRequest } from '../middleware/auth.js';

function requireSessionUser(req: OperatorRequest, res: Response): string | null {
  if (req.authMode !== 'session' || !req.operatorId) {
    res.status(401).json({ error_code: 'SESSION_REQUIRED', message: 'Interactive account session is required.' });
    return null;
  }

  return req.operatorId;
}

export function createIdentityController(): Router {
  const router = Router();

  router.get('/me', async (req: Request, res: Response) => {
    const userId = requireSessionUser(req as OperatorRequest, res);
    if (!userId) return;

    const view = await buildMeProfileView(userId);
    if (!view) {
      res.status(404).json({ error_code: 'ACCOUNT_NOT_FOUND', message: 'Account profile was not found.' });
      return;
    }

    res.json(view);
  });

  router.patch('/me/profile', async (req: Request, res: Response) => {
    const userId = requireSessionUser(req as OperatorRequest, res);
    if (!userId) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const displayName = typeof body.display_name === 'string' ? body.display_name : undefined;
    const avatarUrl = body.avatar_url === null
      ? null
      : typeof body.avatar_url === 'string'
        ? body.avatar_url
        : undefined;
    const primaryEmailRaw = typeof body.primary_email === 'string' ? body.primary_email.trim().toLowerCase() : undefined;
    const primaryEmail = primaryEmailRaw && primaryEmailRaw.includes('@') ? primaryEmailRaw : undefined;

    const updated = await updateAuthUserProfile({
      user_id: userId,
      ...(displayName !== undefined ? { display_name: displayName } : {}),
      ...(avatarUrl !== undefined ? { avatar_url: avatarUrl } : {})
    });

    if (!updated.ok) {
      res.status(400).json({ error_code: updated.error_code, message: updated.message });
      return;
    }

    let profile = await ensureAccountProfileForAuthUser(userId);
    if (!profile) {
      res.status(404).json({ error_code: 'ACCOUNT_NOT_FOUND', message: 'Account profile was not found.' });
      return;
    }

    if (primaryEmail && primaryEmail !== profile.primaryEmail) {
      const now = new Date().toISOString();
      profile = { ...profile, primaryEmail, updatedAt: now };
      await upsertAccountProfile(profile);
    }

    res.json({
      ok: true,
      account: profile
    });
  });

  router.get('/me/organizations', async (req: Request, res: Response) => {
    const userId = requireSessionUser(req as OperatorRequest, res);
    if (!userId) return;

    const organizations = await listOrganizationsForAuthUser(userId);
    if (!organizations) {
      res.status(404).json({ error_code: 'ACCOUNT_NOT_FOUND', message: 'Account profile was not found.' });
      return;
    }

    res.json(organizations);
  });

  router.get('/me/devices', async (req: Request, res: Response) => {
    const userId = requireSessionUser(req as OperatorRequest, res);
    if (!userId) return;

    const devices = await listDevicesForAuthUser(userId);
    if (!devices) {
      res.status(404).json({ error_code: 'ACCOUNT_NOT_FOUND', message: 'Account profile was not found.' });
      return;
    }

    res.json(devices);
  });

  router.post('/me/devices/:deviceId/revoke', async (req: Request, res: Response) => {
    const userId = requireSessionUser(req as OperatorRequest, res);
    if (!userId) return;

    const account = await ensureAccountProfileForAuthUser(userId);
    if (!account) {
      res.status(404).json({ error_code: 'ACCOUNT_NOT_FOUND', message: 'Account profile was not found.' });
      return;
    }

    const deviceId = req.params.deviceId;
    if (!deviceId) {
      res.status(400).json({ error_code: 'VALIDATION_ERROR', message: 'deviceId is required.' });
      return;
    }

    const updated = await revokeDeviceForAccount(account.accountId, deviceId);
    if (!updated) {
      res.status(404).json({ error_code: 'DEVICE_NOT_FOUND', message: 'Device not found for this account.' });
      return;
    }

    res.json({
      ok: true,
      device: updated
    });
  });

  router.post('/me/devices/:deviceId/unlink', async (req: Request, res: Response) => {
    const userId = requireSessionUser(req as OperatorRequest, res);
    if (!userId) return;

    const account = await ensureAccountProfileForAuthUser(userId);
    if (!account) {
      res.status(404).json({ error_code: 'ACCOUNT_NOT_FOUND', message: 'Account profile was not found.' });
      return;
    }

    const deviceId = req.params.deviceId;
    if (!deviceId) {
      res.status(400).json({ error_code: 'VALIDATION_ERROR', message: 'deviceId is required.' });
      return;
    }

    const updated = await unlinkDeviceForAccount(account.accountId, deviceId);
    if (!updated) {
      res.status(404).json({ error_code: 'DEVICE_NOT_FOUND', message: 'Device not found for this account.' });
      return;
    }

    res.json({
      ok: true,
      device: updated
    });
  });

  router.get('/admin/accounts/:accountId', async (req: Request, res: Response) => {
    const accountId = req.params.accountId;
    if (!accountId) {
      res.status(400).json({ error_code: 'VALIDATION_ERROR', message: 'accountId is required.' });
      return;
    }

    const view = await buildAdminAccountView(accountId);
    if (!view) {
      res.status(404).json({ error_code: 'ACCOUNT_NOT_FOUND', message: 'Account profile was not found.' });
      return;
    }

    res.json(view);
  });

  router.get('/admin/accounts/:accountId/devices', async (req: Request, res: Response) => {
    const accountId = req.params.accountId;
    if (!accountId) {
      res.status(400).json({ error_code: 'VALIDATION_ERROR', message: 'accountId is required.' });
      return;
    }

    const devices = await listDevicesForAccount(accountId);
    if (!devices) {
      res.status(404).json({ error_code: 'ACCOUNT_NOT_FOUND', message: 'Account profile was not found.' });
      return;
    }

    res.json(devices);
  });

  router.post('/admin/accounts/:accountId/devices/:deviceId/revoke', async (req: Request, res: Response) => {
    const accountId = req.params.accountId;
    const deviceId = req.params.deviceId;
    if (!accountId || !deviceId) {
      res.status(400).json({ error_code: 'VALIDATION_ERROR', message: 'accountId and deviceId are required.' });
      return;
    }

    const updated = await revokeDeviceForAccount(accountId, deviceId);
    if (!updated) {
      res.status(404).json({ error_code: 'DEVICE_NOT_FOUND', message: 'Device not found for this account.' });
      return;
    }

    res.json({
      ok: true,
      device: updated
    });
  });

  router.post('/admin/accounts/:accountId/devices/:deviceId/unlink', async (req: Request, res: Response) => {
    const accountId = req.params.accountId;
    const deviceId = req.params.deviceId;
    if (!accountId || !deviceId) {
      res.status(400).json({ error_code: 'VALIDATION_ERROR', message: 'accountId and deviceId are required.' });
      return;
    }

    const updated = await unlinkDeviceForAccount(accountId, deviceId);
    if (!updated) {
      res.status(404).json({ error_code: 'DEVICE_NOT_FOUND', message: 'Device not found for this account.' });
      return;
    }

    res.json({
      ok: true,
      device: updated
    });
  });

  // Admin endpoint: update a user's primaryEmail by their user_id (login credential).
  // Usage: PATCH /v1/identity/admin/accounts/primary-email
  // Body: { "user_id": "old@email.com", "primary_email": "new@email.com" }
  router.patch('/admin/accounts/primary-email', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const userId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
      const newEmail = typeof body.primary_email === 'string' ? body.primary_email.trim().toLowerCase() : '';
      if (!userId || !newEmail || !newEmail.includes('@')) {
        res.status(400).json({ error_code: 'VALIDATION_ERROR', message: 'user_id and a valid primary_email are required.' });
        return;
      }

      const profile = await getAccountProfileByPrimaryEmail(userId);
      if (!profile) {
        res.status(404).json({ error_code: 'ACCOUNT_NOT_FOUND', message: `No account found with primary_email: ${userId}` });
        return;
      }

      // If the new email is already claimed by a different account, displace it first
      const conflict = await getAccountProfileByPrimaryEmail(newEmail);
      if (conflict && conflict.accountId !== profile.accountId) {
        const nowConflict = new Date().toISOString();
        const displaced = { ...conflict, primaryEmail: `displaced-${conflict.accountId}@porta.internal`, updatedAt: nowConflict };
        await upsertAccountProfile(displaced);
      }

      const now = new Date().toISOString();
      const updated = { ...profile, primaryEmail: newEmail, updatedAt: now };
      await upsertAccountProfile(updated);
      res.json({ ok: true, account: updated });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error_code: 'INTERNAL_ERROR', message });
    }
  });

  router.get('/admin/organizations/:orgId', async (req: Request, res: Response) => {
    const orgId = req.params.orgId;
    if (!orgId) {
      res.status(400).json({ error_code: 'VALIDATION_ERROR', message: 'orgId is required.' });
      return;
    }

    const view = await buildAdminOrganizationView(orgId);
    if (!view) {
      res.status(404).json({ error_code: 'ORGANIZATION_NOT_FOUND', message: 'Organization profile was not found.' });
      return;
    }

    res.json(view);
  });

  return router;
}
