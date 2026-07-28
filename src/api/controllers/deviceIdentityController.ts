import { Request, Response, Router } from 'express';
import type { ConsentState, DeviceAccountLinkRequest, DeviceAccountUnlinkRequest, DeviceRegistrationRequest, TelemetryLevel } from '@porta/api-contracts';
import { linkDeviceIdentity, registerDeviceIdentity, unlinkDeviceIdentity } from '../../core/identityProfileService.js';
import { requireAccountSession, type OperatorRequest } from '../middleware/auth.js';
import { getDeviceProfile } from '../../store/deviceStore.js';
import { issueDeviceSecret } from '../../store/deviceCredentialStore.js';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

function isOptionalConsentState(value: unknown): value is ConsentState | null | undefined {
  return value === undefined
    || value === null
    || value === 'accepted'
    || value === 'declined'
    || value === 'revoked';
}

function isOptionalTelemetryLevel(value: unknown): value is TelemetryLevel | null | undefined {
  return value === undefined
    || value === null
    || value === 'essential'
    || value === 'enhanced';
}

function parseDeviceRegistrationRequest(body: unknown): DeviceRegistrationRequest | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const payload = body as Record<string, unknown>;
  if (
    !isNonEmptyString(payload.deviceId) ||
    !isNonEmptyString(payload.machineName) ||
    !isNonEmptyString(payload.platform) ||
    !isNonEmptyString(payload.agentVersion) ||
    !isOptionalString(payload.deviceDisplayName) ||
    !isOptionalString(payload.accountId) ||
    !isOptionalString(payload.orgId) ||
    !isOptionalConsentState(payload.deviceCaptureConsentState) ||
    !isOptionalString(payload.deviceCaptureConsentVersion) ||
    !isOptionalString(payload.deviceCaptureConsentedAt) ||
    !isOptionalTelemetryLevel(payload.deviceCaptureTelemetryLevel) ||
    !isOptionalString(payload.sessionToken) ||
    !isOptionalString(payload.localProofToken)
  ) {
    return null;
  }

  return {
    deviceId: payload.deviceId.trim(),
    machineName: payload.machineName.trim(),
    deviceDisplayName: payload.deviceDisplayName?.trim() ?? null,
    platform: payload.platform.trim(),
    agentVersion: payload.agentVersion.trim(),
    accountId: payload.accountId?.trim() ?? null,
    orgId: payload.orgId?.trim() ?? null,
    deviceCaptureConsentState: payload.deviceCaptureConsentState ?? null,
    deviceCaptureConsentVersion: payload.deviceCaptureConsentVersion?.trim() ?? null,
    deviceCaptureConsentedAt: payload.deviceCaptureConsentedAt?.trim() ?? null,
    deviceCaptureTelemetryLevel: payload.deviceCaptureTelemetryLevel ?? null,
    sessionToken: payload.sessionToken?.trim() ?? null,
    localProofToken: payload.localProofToken?.trim() ?? null
  };
}

function parseDeviceAccountLinkRequest(body: unknown): DeviceAccountLinkRequest | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const payload = body as Record<string, unknown>;
  if (
    !isNonEmptyString(payload.deviceId) ||
    !isNonEmptyString(payload.accountId) ||
    !isNonEmptyString(payload.orgId) ||
    !isOptionalString(payload.sessionToken) ||
    !isOptionalString(payload.localProofToken)
  ) {
    return null;
  }

  return {
    deviceId: payload.deviceId.trim(),
    accountId: payload.accountId.trim(),
    orgId: payload.orgId.trim(),
    sessionToken: payload.sessionToken?.trim() ?? null,
    localProofToken: payload.localProofToken?.trim() ?? null
  };
}

function parseDeviceAccountUnlinkRequest(body: unknown): DeviceAccountUnlinkRequest | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const payload = body as Record<string, unknown>;
  if (
    !isNonEmptyString(payload.deviceId) ||
    !isOptionalString(payload.accountId) ||
    !isOptionalString(payload.orgId) ||
    !isOptionalString(payload.sessionToken) ||
    !isOptionalString(payload.localProofToken)
  ) {
    return null;
  }

  return {
    deviceId: payload.deviceId.trim(),
    accountId: payload.accountId?.trim() ?? null,
    orgId: payload.orgId?.trim() ?? null,
    sessionToken: payload.sessionToken?.trim() ?? null,
    localProofToken: payload.localProofToken?.trim() ?? null
  };
}

export function createDeviceIdentityController(): Router {
  const router = Router();

  router.post('/register', async (req: Request, res: Response, next) => {
    try {
      const payload = parseDeviceRegistrationRequest(req.body);
      if (!payload) {
        res.status(400).json({ error_code: 'VALIDATION_ERROR', message: 'Invalid device registration payload.' });
        return;
      }

      const result = await registerDeviceIdentity(payload);
      if (!result.ok) {
        res.status(result.error.status).json({ error_code: result.error.errorCode, message: result.error.message });
        return;
      }

      res.json(result.value);
    } catch (error) {
      next(error);
    }
  });

  router.post('/link-account', requireAccountSession, async (req: Request, res: Response, next) => {
    try {
      const payload = parseDeviceAccountLinkRequest(req.body);
      if (!payload) {
        res.status(400).json({ error_code: 'VALIDATION_ERROR', message: 'Invalid device account link payload.' });
        return;
      }

      const sessionAccountId = (req as OperatorRequest).operatorAccountId;
      if (!sessionAccountId || sessionAccountId !== payload.accountId) {
        res.status(403).json({
          error_code: 'ACCOUNT_MISMATCH',
          message: 'The signed-in account may only link a device to itself.'
        });
        return;
      }

      const result = await linkDeviceIdentity(payload);
      if (!result.ok) {
        res.status(result.error.status).json({ error_code: result.error.errorCode, message: result.error.message });
        return;
      }

      res.json(result.value);
    } catch (error) {
      next(error);
    }
  });

  router.post('/unlink-account', requireAccountSession, async (req: Request, res: Response, next) => {
    try {
      const payload = parseDeviceAccountUnlinkRequest(req.body);
      if (!payload) {
        res.status(400).json({ error_code: 'VALIDATION_ERROR', message: 'Invalid device account unlink payload.' });
        return;
      }

      const sessionAccountId = (req as OperatorRequest).operatorAccountId;
      if (!sessionAccountId || (payload.accountId !== null && sessionAccountId !== payload.accountId)) {
        res.status(403).json({
          error_code: 'ACCOUNT_MISMATCH',
          message: 'The signed-in account may only unlink a device from itself.'
        });
        return;
      }

      // accountId is optional on the wire, and unlinkDeviceIdentity skips its
      // ownership check when it is null — which would let any signed-in account
      // unlink any device by id. Substitute the session account so the check runs.
      const result = await unlinkDeviceIdentity({ ...payload, accountId: sessionAccountId });
      if (!result.ok) {
        res.status(result.error.status).json({ error_code: result.error.errorCode, message: result.error.message });
        return;
      }

      res.json(result.value);
    } catch (error) {
      next(error);
    }
  });

  /**
   * Issues the per-device credential. Separate from /register on purpose: registration is
   * called by the service as LocalSystem at boot, before anyone has signed in, so it cannot
   * carry a credential and must stay open as inventory-only. Handing out a secret is the part
   * that needs proof of who is asking, so it lives here behind an account session.
   *
   * The plaintext secret is returned exactly once. Calling this again rotates it, which is
   * also how a leaked credential is revoked.
   */
  router.post('/issue-credential', requireAccountSession, async (req: Request, res: Response, next) => {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      const deviceId = isNonEmptyString(body?.deviceId) ? body.deviceId.trim() : null;
      if (!deviceId) {
        res.status(400).json({ error_code: 'VALIDATION_ERROR', message: 'A deviceId is required.' });
        return;
      }

      const sessionAccountId = (req as OperatorRequest).operatorAccountId;
      if (!sessionAccountId) {
        res.status(403).json({ error_code: 'ACCOUNT_MISMATCH', message: 'This session has no account.' });
        return;
      }

      const device = await getDeviceProfile(deviceId);
      if (!device) {
        res.status(404).json({ error_code: 'DEVICE_NOT_FOUND', message: 'Device profile was not found.' });
        return;
      }

      // A credential is only meaningful for a device this account owns. An unlinked device
      // has no account to speak for, so it gets no secret.
      if (device.currentAccountId !== sessionAccountId) {
        res.status(403).json({
          error_code: 'ACCOUNT_MISMATCH',
          message: 'A device credential may only be issued for a device linked to the signed-in account.'
        });
        return;
      }

      if (device.status === 'revoked') {
        res.status(409).json({
          error_code: 'DEVICE_REVOKED',
          message: 'This device was revoked and cannot be issued a credential.'
        });
        return;
      }

      const { secret, record } = await issueDeviceSecret(deviceId);
      res.json({
        ok: true,
        deviceId,
        deviceSecret: secret,
        issuedAtUtc: record.createdAtUtc
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
