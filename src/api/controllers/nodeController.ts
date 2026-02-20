import { Router } from 'express';
import { runtimeState } from '../../store/runtimeState.js';

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

const TOTAL_NODES = 1_040;

function cohortForIndex(index: number): Cohort {
  if (index < 940) return 'stable';
  if (index < 950) return 'canary-1';
  if (index < 1_000) return 'canary-5';
  if (index < 1_025) return 'internal';
  return 'experimental';
}

function uuidFromIndex(index: number): string {
  const value = (index + 1).toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${value}`;
}

function degradationFor(index: number, cohort: Cohort): DegradationState {
  const seed = (index * 37) % 100;
  if (cohort === 'experimental' && seed < 24) return 'degraded';
  if (cohort === 'canary-5' && seed < 12) return 'degraded';
  if (seed > 96) return 'safe';
  return 'normal';
}

function heartbeatIso(index: number): string {
  const lagSeconds = index % 18;
  return new Date(Date.now() - lagSeconds * 1_000).toISOString();
}

function signatureValid(index: number): boolean {
  return index % 41 !== 0;
}

function sloFor(degradationState: DegradationState, signatureValidValue: boolean): SloCompliance {
  return degradationState === 'degraded' || !signatureValidValue ? 'breach' : 'compliant';
}

export function createNodeController(): Router {
  const router = Router();

  router.get('/snapshot', (_req, res) => {
    const rows: NodeSnapshotRow[] = Array.from({ length: TOTAL_NODES }, (_, index) => {
      const cohort = cohortForIndex(index);
      const degradationState = degradationFor(index, cohort);
      const isSignatureValid = signatureValid(index);

      return {
        node_id: uuidFromIndex(index),
        cohort,
        config_seq: runtimeState.currentConfigSeq,
        signature_valid: isSignatureValid,
        last_heartbeat: heartbeatIso(index),
        degradation_state: degradationState,
        SLO_compliance: sloFor(degradationState, isSignatureValid)
      };
    });

    res.json(rows);
  });

  return router;
}
