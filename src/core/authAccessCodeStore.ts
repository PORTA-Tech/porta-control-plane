import fs from 'node:fs';
import path from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';

type CodeType = 'signup' | 'password_reset';

interface AccessCodeRecord {
  id: string;
  type: CodeType;
  code: string;
  user_id?: string;
  created_by: string;
  created_at_utc: string;
  expires_at_utc: string;
  used_at_utc?: string;
}

const codesPath = path.resolve('.data', 'auth-access-codes.json');
let loaded = false;
let records: AccessCodeRecord[] = [];

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.trunc(parsed)) : fallback;
}

function defaultTtlMinutes(): number {
  return parsePositiveInt(process.env.AUTH_ACCESS_CODE_TTL_MINUTES, 30);
}

function generateSixDigitCode(): string {
  const value = randomInt(0, 1_000_000);
  return value.toString().padStart(6, '0');
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  if (!fs.existsSync(codesPath)) {
    records = [];
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(codesPath, 'utf8'));
    if (!Array.isArray(parsed)) {
      records = [];
      return;
    }
    records = parsed
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        const row = item as Record<string, unknown>;
        const type = row.type === 'password_reset' ? 'password_reset' : 'signup';
        return {
          id: typeof row.id === 'string' ? row.id : randomUUID(),
          type,
          code: typeof row.code === 'string' ? row.code : generateSixDigitCode(),
          ...(typeof row.user_id === 'string' ? { user_id: row.user_id } : {}),
          created_by: typeof row.created_by === 'string' ? row.created_by : 'system',
          created_at_utc: typeof row.created_at_utc === 'string' ? row.created_at_utc : new Date().toISOString(),
          expires_at_utc: typeof row.expires_at_utc === 'string' ? row.expires_at_utc : new Date().toISOString(),
          ...(typeof row.used_at_utc === 'string' ? { used_at_utc: row.used_at_utc } : {})
        } satisfies AccessCodeRecord;
      });
  } catch {
    records = [];
  }
}

function persist(): void {
  fs.mkdirSync(path.dirname(codesPath), { recursive: true });
  const tmp = `${codesPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2));
  fs.renameSync(tmp, codesPath);
}

function isActive(record: AccessCodeRecord, nowMs = Date.now()): boolean {
  if (record.used_at_utc) return false;
  const expiry = Date.parse(record.expires_at_utc);
  return Number.isFinite(expiry) && expiry > nowMs;
}

function cleanup(): void {
  ensureLoaded();
  const nowMs = Date.now();
  const before = records.length;
  records = records.filter((row) => isActive(row, nowMs) || row.used_at_utc);
  if (records.length !== before) {
    persist();
  }
}

function createCode(input: { type: CodeType; createdBy: string; userId?: string; ttlMinutes?: number }): AccessCodeRecord {
  ensureLoaded();
  cleanup();
  const ttl = input.ttlMinutes ?? defaultTtlMinutes();
  const now = new Date();
  const expiry = new Date(now.getTime() + ttl * 60_000);
  const record: AccessCodeRecord = {
    id: randomUUID(),
    type: input.type,
    code: generateSixDigitCode(),
    ...(input.userId ? { user_id: input.userId } : {}),
    created_by: input.createdBy,
    created_at_utc: now.toISOString(),
    expires_at_utc: expiry.toISOString()
  };
  records.push(record);
  persist();
  return record;
}

export function generateSignupCode(createdBy: string, ttlMinutes?: number): AccessCodeRecord {
  return createCode({
    type: 'signup',
    createdBy,
    ...(ttlMinutes !== undefined ? { ttlMinutes } : {})
  });
}

export function generatePasswordResetCode(createdBy: string, userId: string, ttlMinutes?: number): AccessCodeRecord {
  return createCode({
    type: 'password_reset',
    createdBy,
    userId,
    ...(ttlMinutes !== undefined ? { ttlMinutes } : {})
  });
}

export function consumeSignupCode(code: string): { ok: true } | { ok: false; error_code: string; message: string } {
  ensureLoaded();
  cleanup();
  const normalized = code.trim();
  const nowMs = Date.now();
  const record = records.find((row) => row.type === 'signup' && row.code === normalized && isActive(row, nowMs));
  if (!record) {
    return { ok: false, error_code: 'INVALID_SIGNUP_CODE', message: 'Signup code is invalid or expired.' };
  }
  record.used_at_utc = new Date().toISOString();
  persist();
  return { ok: true };
}

export function consumePasswordResetCode(input: {
  code: string;
  userId: string;
}): { ok: true } | { ok: false; error_code: string; message: string } {
  ensureLoaded();
  cleanup();
  const normalized = input.code.trim();
  const nowMs = Date.now();
  const record = records.find((row) => {
    return (
      row.type === 'password_reset'
      && row.code === normalized
      && row.user_id?.toLowerCase() === input.userId.trim().toLowerCase()
      && isActive(row, nowMs)
    );
  });
  if (!record) {
    return { ok: false, error_code: 'INVALID_RESET_CODE', message: 'Reset code is invalid, expired, or does not match user.' };
  }
  record.used_at_utc = new Date().toISOString();
  persist();
  return { ok: true };
}

export function listActiveAccessCodes(type: CodeType | 'all' = 'all'): AccessCodeRecord[] {
  ensureLoaded();
  cleanup();
  const nowMs = Date.now();
  return records
    .filter((row) => (type === 'all' ? true : row.type === type))
    .filter((row) => isActive(row, nowMs))
    .sort((a, b) => Date.parse(b.created_at_utc) - Date.parse(a.created_at_utc));
}
