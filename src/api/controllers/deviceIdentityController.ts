import { Request, Response, Router } from 'express';
import type { ConsentState, DeviceAccountLinkRequest, DeviceAccountUnlinkRequest, DeviceRegistrationRequest, TelemetryLevel } from '@porta/api-contracts';
import { linkDeviceIdentity, registerDeviceIdentity, unlinkDeviceIdentity } from '../../core/identityProfileService.js';

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

  router.post('/link-account', async (req: Request, res: Response, next) => {
    try {
      const payload = parseDeviceAccountLinkRequest(req.body);
      if (!payload) {
        res.status(400).json({ error_code: 'VALIDATION_ERROR', message: 'Invalid device account link payload.' });
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

  router.post('/unlink-account', async (req: Request, res: Response, next) => {
    try {
      const payload = parseDeviceAccountUnlinkRequest(req.body);
      if (!payload) {
        res.status(400).json({ error_code: 'VALIDATION_ERROR', message: 'Invalid device account unlink payload.' });
        return;
      }

      const result = await unlinkDeviceIdentity(payload);
      if (!result.ok) {
        res.status(result.error.status).json({ error_code: result.error.errorCode, message: result.error.message });
        return;
      }

      res.json(result.value);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
