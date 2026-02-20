import express, { Express } from 'express';
import { createConfigController } from './api/controllers/configController.js';
import { createRolloutController } from './api/controllers/rolloutController.js';
import { createSloController } from './api/controllers/sloController.js';
import { createAuditController } from './api/controllers/auditController.js';
import { enforceRbacPolicy, requireAuthenticatedOperator } from './api/middleware/auth.js';
import { loadOrCreateNodeIdentity, refreshInstanceId } from './core/nodeIdentity.js';
import { verifyLedgerIntegrity } from './core/auditLedger.js';
import { loadRuntimeState, runtimeState } from './store/runtimeState.js';

export function initializeControlPlane(): void {
  const startupIdentity = refreshInstanceId(loadOrCreateNodeIdentity());
  const state = loadRuntimeState();
  const integrity = verifyLedgerIntegrity();
  if (!integrity.ok) {
    throw new Error(`Ledger integrity check failed at index=${integrity.index} reason=${integrity.reason}`);
  }

  console.log(
    `[control-plane] node_id=${startupIdentity.nodeId} cluster_id=${startupIdentity.clusterId} instance_id=${startupIdentity.instanceId} cohort=${startupIdentity.cohortId}`
  );
  console.log(
    `[control-plane] config_seq=${state.currentConfigSeq} config_version=${state.currentConfigVersion} rollout_state=${runtimeState.rolloutState}`
  );
}

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use('/v1', requireAuthenticatedOperator, enforceRbacPolicy);
  app.use('/v1/config', createConfigController());
  app.use('/v1/rollout', createRolloutController());
  app.use('/v1/slo', createSloController());
  app.use('/v1/audit', createAuditController());

  return app;
}
