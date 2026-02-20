import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigLedgerRecord, ConfigEnvelope } from '@porta/api-contracts';

const ledgerPath = path.resolve('.data', 'config-ledger.ndjson');

function withoutHash(record: ConfigLedgerRecord): Omit<ConfigLedgerRecord, 'hash'> {
  const { hash: _hash, ...rest } = record;
  return rest;
}

function recordHash(record: Omit<ConfigLedgerRecord, 'hash'>): string {
  return crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

export function appendLedgerRecord(record: Omit<ConfigLedgerRecord, 'hash'>): ConfigLedgerRecord {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const ledger = readLedger();
  const previous = ledger.at(-1);
  const inheritedPreviousHash = record.previousHash ?? previous?.hash;
  const normalized: Omit<ConfigLedgerRecord, 'hash'> =
    inheritedPreviousHash === undefined ? record : { ...record, previousHash: inheritedPreviousHash };

  const full: ConfigLedgerRecord = {
    ...normalized,
    hash: recordHash(normalized)
  };

  fs.appendFileSync(ledgerPath, JSON.stringify(full) + '\n');
  return full;
}

export function readLedger(): ConfigLedgerRecord[] {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs
    .readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ConfigLedgerRecord);
}

export interface LedgerIntegrityResult {
  ok: boolean;
  index?: number;
  reason?: 'hash_mismatch' | 'broken_chain';
}

export function verifyLedgerIntegrity(): LedgerIntegrityResult {
  const ledger = readLedger();
  for (let i = 0; i < ledger.length; i++) {
    const item = ledger[i];
    if (!item) {
      return { ok: false, index: i, reason: 'broken_chain' };
    }
    const expectedHash = recordHash(withoutHash(item));
    if (item.hash !== expectedHash) {
      return { ok: false, index: i, reason: 'hash_mismatch' };
    }

    if (i === 0) {
      if (item.previousHash) {
        return { ok: false, index: i, reason: 'broken_chain' };
      }

      continue;
    }

    const previous = ledger[i - 1];
    if (!previous) {
      return { ok: false, index: i, reason: 'broken_chain' };
    }
    const expectedPrevious = previous.hash;
    if (item.previousHash !== expectedPrevious) {
      return { ok: false, index: i, reason: 'broken_chain' };
    }
  }

  return { ok: true };
}

export function buildLedgerRecord(
  envelope: ConfigEnvelope,
  rolloutStatus: ConfigLedgerRecord['rolloutStatus'],
  issuerId: string,
  previousConfigSeq?: number,
  previousHash?: string,
  diffFromPrevious?: string,
  approvalTicket?: string
): Omit<ConfigLedgerRecord, 'hash'> {
  const base: Omit<ConfigLedgerRecord, 'hash'> = {
    configSeq: envelope.configSeq,
    configVersion: envelope.configVersion,
    appliedAtUtc: new Date().toISOString(),
    issuerId,
    payload: envelope.payload,
    rolloutStatus
  };
  return {
    ...base,
    ...(previousConfigSeq !== undefined ? { previousConfigSeq } : {}),
    ...(previousHash !== undefined ? { previousHash } : {}),
    ...(diffFromPrevious !== undefined ? { diffFromPrevious } : {}),
    ...(approvalTicket !== undefined ? { approvalTicket } : {})
  };
}
