import { Router } from 'express';
import { runtimeState } from '../../store/runtimeState.js';
import { listAgentPresence, upsertAgentPresence } from '../../store/agentPresenceStore.js';

interface AgentStatusPayload {
  agentId?: string;
  timestampUtc?: string;
  note?: string;
  status?: unknown;
  control?: unknown;
}

export function createAgentController(): Router {
  const router = Router();

  router.post('/heartbeat', (req, res) => {
    const payload = (req.body ?? {}) as AgentStatusPayload;
    const agentId = typeof payload.agentId === 'string' && payload.agentId.trim().length > 0 ? payload.agentId.trim() : undefined;

    if (!agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }

    const record = upsertAgentPresence(payload);
    if (!record) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }

    res.status(202).json({
      accepted: true,
      agentId,
      heartbeatCount: record.heartbeatCount,
      config_seq: runtimeState.currentConfigSeq,
      config_version: runtimeState.currentConfigVersion,
      signature_validity: runtimeState.currentConfigSignatureValid ?? false,
      applied_at_utc: runtimeState.appliedAtUtc
    });
  });

  router.post('/telemetry', (req, res) => {
    const batch = Array.isArray(req.body) ? req.body : [];
    res.status(202).json({ accepted: true, count: batch.length });
  });

  // Simple diagnostic endpoint for local validation.
  router.get('/presence', (_req, res) => {
    res.json(listAgentPresence());
  });

  return router;
}
