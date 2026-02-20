import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigEnvelope } from '@porta/api-contracts';
import { applySignedConfig } from '../src/core/configManager.js';
import { readLedger } from '../src/core/auditLedger.js';
import { loadRuntimeState, resetRuntimeStateForTests, runtimeState } from '../src/store/runtimeState.js';

const dataDir = path.resolve('.data');

function signEnvelope(payload: Omit<ConfigEnvelope, 'signature'>, privateKeyPem: string): string {
  const canonical = JSON.stringify({
    configVersion: payload.configVersion,
    configSeq: payload.configSeq,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    issuerId: payload.issuerId,
    payload: payload.payload,
    signatureAlgorithm: payload.signatureAlgorithm
  });

  if (payload.signatureAlgorithm === 'ed25519') {
    const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKeyPem);
    return sig.toString('base64');
  }

  const signer = crypto.createSign('SHA256');
  signer.update(canonical);
  signer.end();
  return signer.sign(privateKeyPem).toString('base64');
}

function createEnvelope(overrides: Partial<ConfigEnvelope>, privateKeyPem: string): ConfigEnvelope {
  const base: Omit<ConfigEnvelope, 'signature'> = {
    configVersion: '2026.02.20.01',
    configSeq: 1,
    issuedAt: new Date(Date.now() - 5_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    issuerId: 'control-plane',
    payload: { feature: { alpha: true } },
    signatureAlgorithm: 'ed25519'
  };

  const merged = { ...base, ...overrides } as Omit<ConfigEnvelope, 'signature'>;
  return {
    ...merged,
    signature: signEnvelope(merged, privateKeyPem)
  };
}

describe('config submission critical path', () => {
  let privateKeyPem: string;

  beforeEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    resetRuntimeStateForTests();
    loadRuntimeState();

    const keyPair = crypto.generateKeyPairSync('ed25519');
    privateKeyPem = keyPair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const publicKeyPem = keyPair.publicKey.export({ format: 'pem', type: 'spki' }).toString();

    process.env.CONTROL_PLANE_PUBLIC_KEY_PEM = publicKeyPem;
    process.env.CONTROL_PLANE_TRUSTED_ISSUERS = 'control-plane';
    process.env.CONTROL_PLANE_CLOCK_SKEW_MS = '30000';
  });

  it('accepts a valid signed config and persists state', () => {
    const envelope = createEnvelope({ configSeq: 7, configVersion: '2026.02.20.07' }, privateKeyPem);
    const result = applySignedConfig(envelope, 'admin-a');

    expect(result.applied).toBe(true);
    expect(runtimeState.currentConfigSeq).toBe(7);
    expect(runtimeState.currentConfigVersion).toBe('2026.02.20.07');

    const ledger = readLedger();
    expect(ledger.length).toBe(1);
    expect(ledger[0].diffFromPrevious).toBe('accepted');
  });

  it('rejects replay and keeps current state', () => {
    const first = createEnvelope({ configSeq: 3 }, privateKeyPem);
    const replay = createEnvelope({ configSeq: 3 }, privateKeyPem);

    expect(applySignedConfig(first, 'admin-a').applied).toBe(true);
    const beforeSeq = runtimeState.currentConfigSeq;

    const result = applySignedConfig(replay, 'admin-a');
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('config_seq_not_monotonic');
    expect(runtimeState.currentConfigSeq).toBe(beforeSeq);

    const ledger = readLedger();
    expect(ledger.length).toBe(2);
    expect(ledger[1].diffFromPrevious).toContain('rejected:config_seq_not_monotonic');
  });

  it('rejects expired configs', () => {
    const envelope = createEnvelope({ expiresAt: new Date(Date.now() - 120_000).toISOString() }, privateKeyPem);
    const result = applySignedConfig(envelope, 'admin-a');

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('config_expired');
    expect(runtimeState.currentConfigSeq).toBe(0);
  });

  it('rejects untrusted issuer', () => {
    const envelope = createEnvelope({ issuerId: 'rogue-issuer' }, privateKeyPem);
    const result = applySignedConfig(envelope, 'admin-a');

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('issuer_untrusted');
    expect(runtimeState.currentConfigSeq).toBe(0);
  });

  it('rejects tampered signature', () => {
    const envelope = createEnvelope({ configSeq: 9 }, privateKeyPem);
    envelope.signature = Buffer.from('tampered').toString('base64');

    const result = applySignedConfig(envelope, 'admin-a');
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('signature_invalid');
    expect(runtimeState.currentConfigSeq).toBe(0);
  });
});
