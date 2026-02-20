import crypto from 'node:crypto';
import { ConfigEnvelope } from '@porta/api-contracts';
import { runtimeState } from '../store/runtimeState.js';
import { appendLedgerRecord, buildLedgerRecord, readLedger } from './auditLedger.js';

function parsePublicKey(): string | undefined {
  return process.env.CONTROL_PLANE_PUBLIC_KEY_PEM;
}

function verifySignature(envelope: ConfigEnvelope): boolean {
  const publicKeyPem = parsePublicKey();
  if (!publicKeyPem) {
    return false;
  }

  const payload = {
    configVersion: envelope.configVersion,
    configSeq: envelope.configSeq,
    issuedAt: envelope.issuedAt,
    expiresAt: envelope.expiresAt,
    issuerId: envelope.issuerId,
    payload: envelope.payload,
    signatureAlgorithm: envelope.signatureAlgorithm
  };

  const verifier = crypto.createVerify('SHA256');
  verifier.update(JSON.stringify(payload));
  verifier.end();
  return verifier.verify(publicKeyPem, Buffer.from(envelope.signature, 'base64'));
}

export interface ApplyResult {
  applied: boolean;
  reason?: string;
}

export function applySignedConfig(envelope: ConfigEnvelope, actorId: string): ApplyResult {
  if (!verifySignature(envelope)) {
    const ledger = readLedger();
    appendLedgerRecord(buildLedgerRecord(envelope, 'halted', actorId, runtimeState.currentConfigSeq, ledger.at(-1)?.hash, 'signature_invalid'));
    return { applied: false, reason: 'signature_invalid' };
  }

  const now = Date.now();
  if (Date.parse(envelope.expiresAt) <= now) {
    return { applied: false, reason: 'config_expired' };
  }

  if (envelope.configSeq <= runtimeState.currentConfigSeq) {
    return { applied: false, reason: 'config_seq_not_monotonic' };
  }

  const previousSeq = runtimeState.currentConfigSeq;
  runtimeState.previousConfigSeq = previousSeq;
  runtimeState.currentConfigSeq = envelope.configSeq;
  runtimeState.currentConfigVersion = envelope.configVersion;
  runtimeState.appliedAtUtc = new Date().toISOString();

  const ledger = readLedger();
  appendLedgerRecord(buildLedgerRecord(envelope, 'promoting', actorId, previousSeq, ledger.at(-1)?.hash));
  return { applied: true };
}
