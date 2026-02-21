import { Router } from 'express';

interface AgentStatusPayload {
  agentId?: string;
  timestampUtc?: string;
  note?: string;
  status?: unknown;
  control?: unknown;
}

interface AgentPresenceRow {
  agentId: string;
  lastHeartbeatUtc: string;
  heartbeatCount: number;
  lastNote?: string;
}

const agentPresence = new Map<string, AgentPresenceRow>();

export function createAgentController(): Router {
  const router = Router();

  router.post('/heartbeat', (req, res) => {
    const payload = (req.body ?? {}) as AgentStatusPayload;
    const agentId = typeof payload.agentId === 'string' && payload.agentId.trim().length > 0 ? payload.agentId.trim() : undefined;

    if (!agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }

    const now = new Date().toISOString();
    const existing = agentPresence.get(agentId);
    const record: AgentPresenceRow = {
      agentId,
      lastHeartbeatUtc: typeof payload.timestampUtc === 'string' && payload.timestampUtc.length > 0 ? payload.timestampUtc : now,
      heartbeatCount: (existing?.heartbeatCount ?? 0) + 1,
      ...(typeof payload.note === 'string' && payload.note.length > 0 ? { lastNote: payload.note } : {})
    };

    agentPresence.set(agentId, record);
    res.status(202).json({ accepted: true, agentId, heartbeatCount: record.heartbeatCount });
  });

  router.post('/telemetry', (req, res) => {
    const batch = Array.isArray(req.body) ? req.body : [];
    res.status(202).json({ accepted: true, count: batch.length });
  });

  // Simple diagnostic endpoint for local validation.
  router.get('/presence', (_req, res) => {
    res.json(Array.from(agentPresence.values()));
  });

  return router;
}
