import express from 'express';
import { createConfigController } from './api/controllers/configController.js';
import { createRolloutController } from './api/controllers/rolloutController.js';
import { createSloController } from './api/controllers/sloController.js';
import { createAuditController } from './api/controllers/auditController.js';
import { requireAdmin, requireOperator } from './api/middleware/auth.js';
import { loadOrCreateNodeIdentity, refreshInstanceId } from './core/nodeIdentity.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const startupIdentity = refreshInstanceId(loadOrCreateNodeIdentity());
console.log(`[control-plane] node_id=${startupIdentity.nodeId} cluster_id=${startupIdentity.clusterId} instance_id=${startupIdentity.instanceId} cohort=${startupIdentity.cohortId}`);

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/v1', requireOperator);
app.use('/v1/config', createConfigController());
app.use('/v1/rollout', createRolloutController());
app.use('/v1/slo', createSloController());
app.use('/v1/audit', requireAdmin, createAuditController());

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`[control-plane] listening on :${port}`);
});
