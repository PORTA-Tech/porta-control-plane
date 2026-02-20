import { Router, Response } from 'express';
import { ConfigEnvelope } from '@porta/api-contracts';
import { applySignedConfig } from '../../core/configManager.js';
import { readLedger } from '../../core/auditLedger.js';
import { runtimeState } from '../../store/runtimeState.js';
import { OperatorRequest } from '../middleware/auth.js';

function statusForReason(reason?: string): number {
  if (!reason) return 202;
  if (reason === 'config_seq_not_monotonic') return 409;
  if (reason === 'issuer_untrusted' || reason === 'signature_invalid' || reason === 'algorithm_unsupported') return 403;
  return 400;
}

function flattenPayload(payload: Record<string, unknown>, prefix = ''): Map<string, unknown> {
  const flat = new Map<string, unknown>();
  for (const [key, value] of Object.entries(payload)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const nested = flattenPayload(value as Record<string, unknown>, path);
      for (const [nestedKey, nestedValue] of nested) {
        flat.set(nestedKey, nestedValue);
      }
      continue;
    }

    flat.set(path, value);
  }

  return flat;
}

function diffKeys(currentPayload: Record<string, unknown>, targetPayload: Record<string, unknown>): {
  added_keys: string[];
  modified_keys: string[];
  removed_keys: string[];
} {
  const currentFlat = flattenPayload(currentPayload);
  const targetFlat = flattenPayload(targetPayload);
  const keys = new Set([...currentFlat.keys(), ...targetFlat.keys()]);

  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  for (const key of keys) {
    const inCurrent = currentFlat.has(key);
    const inTarget = targetFlat.has(key);

    if (!inCurrent && inTarget) {
      added.push(key);
      continue;
    }

    if (inCurrent && !inTarget) {
      removed.push(key);
      continue;
    }

    const currentValue = currentFlat.get(key);
    const targetValue = targetFlat.get(key);
    if (JSON.stringify(currentValue) !== JSON.stringify(targetValue)) {
      modified.push(key);
    }
  }

  return {
    added_keys: added.sort(),
    modified_keys: modified.sort(),
    removed_keys: removed.sort()
  };
}

function secondsUntil(iso?: string): number {
  if (!iso) return 0;
  return Math.max(0, Math.floor((Date.parse(iso) - Date.now()) / 1000));
}

function integrityStatus(input: {
  signatureValidity: boolean;
  expiryCountdownSeconds: number;
  expiresAtUtc: string | undefined;
}): 'verified' | 'expiry_approaching' | 'invalid_or_expired' {
  const expiryParsed = input.expiresAtUtc ? Date.parse(input.expiresAtUtc) : NaN;
  const expired = !Number.isFinite(expiryParsed) || expiryParsed <= Date.now();
  if (!input.signatureValidity || expired) {
    return 'invalid_or_expired';
  }

  if (input.expiryCountdownSeconds <= 15 * 60) {
    return 'expiry_approaching';
  }

  return 'verified';
}

export function createConfigController(): Router {
  const router = Router();

  router.post('/submit', (req: OperatorRequest, res: Response) => {
    const envelope = req.body as ConfigEnvelope;
    const actorId = req.operatorId ?? 'unknown';
    const result = applySignedConfig(envelope, actorId);
    res.status(statusForReason(result.reason)).json(result);
  });

  router.get('/current', (_req, res) => {
    res.json({
      configSeq: runtimeState.currentConfigSeq,
      configVersion: runtimeState.currentConfigVersion,
      appliedAtUtc: runtimeState.appliedAtUtc
    });
  });

  router.get('/ledger', (_req, res) => {
    res.json(readLedger());
  });

  router.get('/diff-preview', (req, res) => {
    const ledger = readLedger();
    const current = ledger.find((item) => item.configSeq === runtimeState.currentConfigSeq);
    const requestedTargetSeq = Number(req.query.targetConfigSeq);
    const hasRequestedTarget = Number.isInteger(requestedTargetSeq);

    const target =
      (hasRequestedTarget ? ledger.find((item) => item.configSeq === requestedTargetSeq) : undefined) ??
      [...ledger].sort((a, b) => b.configSeq - a.configSeq).find((item) => item.configSeq !== runtimeState.currentConfigSeq) ??
      current;

    const currentPayload =
      current?.payload && typeof current.payload === 'object'
        ? (current.payload as Record<string, unknown>)
        : {};
    const targetPayload =
      target?.payload && typeof target.payload === 'object'
        ? (target.payload as Record<string, unknown>)
        : currentPayload;
    const diff = diffKeys(currentPayload, targetPayload);

    res.json({
      current_config_seq: runtimeState.currentConfigSeq,
      target_config_seq: target?.configSeq ?? runtimeState.currentConfigSeq,
      ...diff,
      hash_fingerprint: target?.hash ?? ''
    });
  });

  router.get('/integrity-active', (_req, res) => {
    const ledger = readLedger();
    const current = ledger.find((item) => item.configSeq === runtimeState.currentConfigSeq);
    const previous = runtimeState.previousConfigSeq
      ? ledger.find((item) => item.configSeq === runtimeState.previousConfigSeq)
      : undefined;

    const currentPayload =
      current?.payload && typeof current.payload === 'object'
        ? (current.payload as Record<string, unknown>)
        : {};
    const previousPayload =
      previous?.payload && typeof previous.payload === 'object'
        ? (previous.payload as Record<string, unknown>)
        : {};

    const fullDiff = diffKeys(previousPayload, currentPayload);
    const expiryCountdownSeconds = secondsUntil(runtimeState.currentConfigExpiresAtUtc);
    const signatureValidity = runtimeState.currentConfigSignatureValid ?? false;

    res.json({
      config_seq: runtimeState.currentConfigSeq,
      config_version: runtimeState.currentConfigVersion,
      issuer: runtimeState.currentConfigIssuerId ?? current?.issuerId ?? 'unknown',
      signature_validity: signatureValidity,
      expires_at_utc: runtimeState.currentConfigExpiresAtUtc ?? runtimeState.appliedAtUtc ?? new Date().toISOString(),
      expiry_countdown_seconds: expiryCountdownSeconds,
      hash_fingerprint: current?.hash ?? '',
      full_diff_from_previous: fullDiff,
      integrity_status: integrityStatus({
        signatureValidity,
        expiryCountdownSeconds,
        expiresAtUtc: runtimeState.currentConfigExpiresAtUtc
      })
    });
  });

  return router;
}
