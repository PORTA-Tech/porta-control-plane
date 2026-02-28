import { Router } from 'express';
import { listAgentPresence } from '../../store/agentPresenceStore.js';

type Cohort = 'stable' | 'canary-1' | 'canary-5' | 'internal' | 'experimental';
type DegradationState = 'normal' | 'degraded' | 'safe';
type SloCompliance = 'compliant' | 'breach';

interface NodeSnapshotRow {
  node_id: string;
  cohort: Cohort;
  config_seq: number;
  signature_valid: boolean;
  last_heartbeat: string;
  degradation_state: DegradationState;
  SLO_compliance: SloCompliance;
}

const parsedStaleHeartbeatSeconds = Number.parseInt(process.env.NODE_STALE_HEARTBEAT_SECONDS ?? '30', 10);
const STALE_HEARTBEAT_SECONDS = Number.isFinite(parsedStaleHeartbeatSeconds) ? parsedStaleHeartbeatSeconds : 30;

function cohortForAgentId(agentId: string): Cohort {
  const hash = Array.from(agentId).reduce((acc, ch) => ((acc * 33) ^ ch.charCodeAt(0)) >>> 0, 5381);
  const bucket = hash % 100;
  if (bucket < 90) return 'stable';
  if (bucket < 91) return 'canary-1';
  if (bucket < 96) return 'canary-5';
  if (bucket < 98) return 'internal';
  return 'experimental';
}

function degradationFor(lastHeartbeatUtc: string, signatureValid: boolean): DegradationState {
  if (!signatureValid) {
    return 'degraded';
  }

  const heartbeatMs = Date.parse(lastHeartbeatUtc);
  if (Number.isFinite(heartbeatMs) && Date.now() - heartbeatMs > STALE_HEARTBEAT_SECONDS * 1_000) {
    return 'degraded';
  }

  return 'normal';
}

function sloFor(degradationState: DegradationState): SloCompliance {
  return degradationState === 'degraded' ? 'breach' : 'compliant';
}

export function createNodeController(): Router {
  const router = Router();

  router.get('/snapshot', (_req, res) => {
    const rows: NodeSnapshotRow[] = listAgentPresence()
      .map((presence) => {
        const degradationState = degradationFor(presence.lastHeartbeatUtc, presence.signatureValidity);
        return {
          node_id: presence.agentId,
          cohort: cohortForAgentId(presence.agentId),
          config_seq: presence.configSeq,
          signature_valid: presence.signatureValidity,
          last_heartbeat: presence.lastHeartbeatUtc,
          degradation_state: degradationState,
          SLO_compliance: sloFor(degradationState)
        };
      })
      .sort((a, b) => Date.parse(b.last_heartbeat) - Date.parse(a.last_heartbeat));

    res.json(rows);
  });

  return router;
}
