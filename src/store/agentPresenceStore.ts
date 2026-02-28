import { runtimeState } from './runtimeState.js';

export interface AgentPresenceRow {
  agentId: string;
  lastHeartbeatUtc: string;
  heartbeatCount: number;
  lastNote?: string;
  configSeq: number;
  configVersion: string;
  signatureValidity: boolean;
}

interface AgentStatusPayload {
  agentId?: string;
  timestampUtc?: string;
  note?: string;
}

const agentPresence = new Map<string, AgentPresenceRow>();

export function upsertAgentPresence(payload: AgentStatusPayload): AgentPresenceRow | null {
  const agentId = typeof payload.agentId === 'string' && payload.agentId.trim().length > 0 ? payload.agentId.trim() : undefined;
  if (!agentId) {
    return null;
  }

  const nowIso = new Date().toISOString();
  const existing = agentPresence.get(agentId);
  const parsedHeartbeat = typeof payload.timestampUtc === 'string' ? Date.parse(payload.timestampUtc) : Number.NaN;

  const record: AgentPresenceRow = {
    agentId,
    lastHeartbeatUtc: Number.isFinite(parsedHeartbeat) ? new Date(parsedHeartbeat).toISOString() : nowIso,
    heartbeatCount: (existing?.heartbeatCount ?? 0) + 1,
    configSeq: runtimeState.currentConfigSeq,
    configVersion: runtimeState.currentConfigVersion,
    signatureValidity: runtimeState.currentConfigSignatureValid ?? false,
    ...(typeof payload.note === 'string' && payload.note.length > 0 ? { lastNote: payload.note } : {})
  };

  agentPresence.set(agentId, record);
  return record;
}

function readStringField(input: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = input[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export function upsertPresenceFromTelemetryBatch(batch: unknown): void {
  if (!Array.isArray(batch)) {
    return;
  }

  for (const item of batch) {
    if (item == null || typeof item !== 'object') {
      continue;
    }

    const record = item as Record<string, unknown>;
    const agentId = readStringField(record, 'agentId', 'AgentId');
    if (!agentId) {
      continue;
    }

    const timestampUtc = readStringField(record, 'timestampUtc', 'TimestampUtc');
    const payload: AgentStatusPayload = {
      agentId,
      note: 'telemetry'
    };
    if (timestampUtc) {
      payload.timestampUtc = timestampUtc;
    }
    upsertAgentPresence(payload);
  }
}

export function listAgentPresence(): AgentPresenceRow[] {
  return Array.from(agentPresence.values());
}

export function clearAgentPresence(): void {
  agentPresence.clear();
}
