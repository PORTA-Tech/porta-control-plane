import crypto from 'node:crypto';
import { ConfigEnvelope } from '@porta/api-contracts';
import { runtimeState, persistRuntimeState } from '../store/runtimeState.js';
import { appendLedgerRecord, buildLedgerRecord, readLedger } from './auditLedger.js';

const supportedAlgorithms = new Set(['ed25519', 'ecdsa-p256']);

export type RejectReason =
  | 'signature_invalid'
  | 'issuer_untrusted'
  | 'config_expired'
  | 'issued_at_in_future'
  | 'config_seq_not_monotonic'
  | 'algorithm_unsupported'
  | 'timestamp_invalid';

export interface ApplyResult {
  applied: boolean;
  reason?: RejectReason;
}

function parseTrustedIssuers(): Set<string> {
  const raw = process.env.CONTROL_PLANE_TRUSTED_ISSUERS ?? '';
  return new Set(
    raw
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  );
}

function parseClockSkewMs(): number {
  const raw = Number(process.env.CONTROL_PLANE_CLOCK_SKEW_MS ?? 30_000);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30_000;
}

function parsePublicKey(): string | undefined {
  const value = process.env.CONTROL_PLANE_PUBLIC_KEY_PEM;
  return value && value.trim().length > 0 ? value : undefined;
}

function canonicalPayload(envelope: ConfigEnvelope): string {
  return JSON.stringify({
    configVersion: envelope.configVersion,
    configSeq: envelope.configSeq,
    issuedAt: envelope.issuedAt,
    expiresAt: envelope.expiresAt,
    issuerId: envelope.issuerId,
    payload: envelope.payload,
    signatureAlgorithm: envelope.signatureAlgorithm
  });
}

function verifySignature(envelope: ConfigEnvelope): boolean {
  const publicKeyPem = parsePublicKey();
  if (!publicKeyPem) {
    return false;
  }

  let signature: Buffer;
  try {
    signature = Buffer.from(envelope.signature, 'base64');
  } catch {
    return false;
  }

  const data = Buffer.from(canonicalPayload(envelope), 'utf8');
  if (envelope.signatureAlgorithm === 'ed25519') {
    return crypto.verify(null, data, publicKeyPem, signature);
  }

  if (envelope.signatureAlgorithm === 'ecdsa-p256') {
    const verifier = crypto.createVerify('SHA256');
    verifier.update(data);
    verifier.end();
    return verifier.verify(publicKeyPem, signature);
  }

  return false;
}

function appendDecision(envelope: ConfigEnvelope, actorId: string, reason: string, accepted: boolean): void {
  const ledger = readLedger();
  const previousHash = ledger.at(-1)?.hash;
  const previousSeq = runtimeState.currentConfigSeq;
  const rolloutStatus = accepted ? 'promoting' : 'halted';
  appendLedgerRecord(
    buildLedgerRecord(
      envelope,
      rolloutStatus,
      actorId,
      previousSeq,
      previousHash,
      accepted ? 'accepted' : `rejected:${reason}`
    )
  );
}

function validateEnvelope(envelope: ConfigEnvelope): RejectReason | undefined {
  if (!supportedAlgorithms.has(envelope.signatureAlgorithm)) {
    return 'algorithm_unsupported';
  }

  const trustedIssuers = parseTrustedIssuers();
  if (!trustedIssuers.has(envelope.issuerId)) {
    return 'issuer_untrusted';
  }

  const issuedAtMs = Date.parse(envelope.issuedAt);
  const expiresAtMs = Date.parse(envelope.expiresAt);
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)) {
    return 'timestamp_invalid';
  }

  const now = Date.now();
  const skewMs = parseClockSkewMs();
  if (issuedAtMs > now + skewMs) {
    return 'issued_at_in_future';
  }

  if (expiresAtMs <= now - skewMs) {
    return 'config_expired';
  }

  if (!Number.isInteger(envelope.configSeq) || envelope.configSeq <= runtimeState.currentConfigSeq) {
    return 'config_seq_not_monotonic';
  }

  if (!verifySignature(envelope)) {
    return 'signature_invalid';
  }

  return undefined;
}

export function applySignedConfig(envelope: ConfigEnvelope, actorId: string): ApplyResult {
  const rejection = validateEnvelope(envelope);
  if (rejection) {
    appendDecision(envelope, actorId, rejection, false);
    return { applied: false, reason: rejection };
  }

  const previousSeq = runtimeState.currentConfigSeq;
  const previousVersion = runtimeState.currentConfigVersion;
  runtimeState.previousConfigSeq = previousSeq;
  runtimeState.previousConfigVersion = previousVersion;
  runtimeState.currentConfigSeq = envelope.configSeq;
  runtimeState.currentConfigVersion = envelope.configVersion;
  runtimeState.appliedAtUtc = new Date().toISOString();
  persistRuntimeState();

  appendDecision(envelope, actorId, 'accepted', true);
  return { applied: true };
}
