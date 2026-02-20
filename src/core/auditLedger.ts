import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigLedgerRecord, ConfigEnvelope } from '@porta/api-contracts';

const ledgerPath = path.resolve('.data', 'config-ledger.ndjson');

function recordHash(record: Omit<ConfigLedgerRecord, 'hash'>): string {
  return crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

export function appendLedgerRecord(record: Omit<ConfigLedgerRecord, 'hash'>): ConfigLedgerRecord {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const full: ConfigLedgerRecord = {
    ...record,
    hash: recordHash(record)
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

export function buildLedgerRecord(
  envelope: ConfigEnvelope,
  rolloutStatus: ConfigLedgerRecord['rolloutStatus'],
  issuerId: string,
  previousConfigSeq?: number,
  previousHash?: string,
  diffFromPrevious?: string,
  approvalTicket?: string
): Omit<ConfigLedgerRecord, 'hash'> {
  return {
    configSeq: envelope.configSeq,
    configVersion: envelope.configVersion,
    appliedAtUtc: new Date().toISOString(),
    issuerId,
    payload: envelope.payload,
    previousConfigSeq,
    previousHash,
    diffFromPrevious,
    approvalTicket,
    rolloutStatus
  };
}
