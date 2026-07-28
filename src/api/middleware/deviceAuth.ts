import { NextFunction, Request, Response } from 'express';
import { deviceSecretMatches, getDeviceCredential } from '../../store/deviceCredentialStore.js';

export type DeviceAuthMode = 'log' | 'enforce';

export interface DeviceRequest extends Request {
  /** The device id proven by a valid credential. Absent when the caller did not prove one. */
  authenticatedDeviceId?: string;
  deviceAuthenticated?: boolean;
}

export const DEVICE_ID_HEADER = 'x-porta-device-id';
export const DEVICE_SECRET_HEADER = 'x-porta-device-secret';

/**
 * Rollout switch. Defaults to 'log' so a deploy can never lock the fleet out: an agent
 * without a credential keeps working and is merely counted. Only flip to 'enforce' once
 * no linked, recently-seen device is missing a credential -- an adoption count is not the
 * gate, because a device can be fully updated and still hold no credential.
 */
export function getDeviceAuthMode(): DeviceAuthMode {
  return process.env.PORTA_DEVICE_AUTH_MODE === 'enforce' ? 'enforce' : 'log';
}

/**
 * Verifies the device credential headers if they are present. Never rejects on its own --
 * it only records what was proven, and leaves the decision to the route. Routes that must
 * be closed use requireDeviceAuth below; routes that degrade (machine-summary) read
 * deviceAuthenticated and downgrade what they are willing to write.
 */
export async function attachDeviceIdentity(req: DeviceRequest, _res: Response, next: NextFunction): Promise<void> {
  try {
    const deviceId = readHeader(req, DEVICE_ID_HEADER);
    const secret = readHeader(req, DEVICE_SECRET_HEADER);
    if (!deviceId || !secret) {
      req.deviceAuthenticated = false;
      next();
      return;
    }

    const credential = await getDeviceCredential(deviceId);
    if (!credential || !deviceSecretMatches(secret, credential.secretHash)) {
      req.deviceAuthenticated = false;
      next();
      return;
    }

    req.authenticatedDeviceId = deviceId;
    req.deviceAuthenticated = true;
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Closes a route to callers without a valid device credential -- but only in enforce mode.
 * In log mode the request proceeds so the current fleet keeps reporting while agents update.
 */
export async function requireDeviceAuth(req: DeviceRequest, res: Response, next: NextFunction): Promise<void> {
  await attachDeviceIdentity(req, res, () => {
    if (req.deviceAuthenticated || getDeviceAuthMode() === 'log') {
      next();
      return;
    }

    res.status(401).json({
      error: 'unauthorized',
      error_code: 'DEVICE_CREDENTIAL_REQUIRED',
      message: 'This endpoint requires a device credential.'
    });
  });
}

function readHeader(req: Request, name: string): string | null {
  const raw = req.header(name);
  if (typeof raw !== 'string') {
    return null;
  }

  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
