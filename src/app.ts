import express, { Express } from 'express';
import { createConfigController } from './api/controllers/configController.js';
import { createRolloutController } from './api/controllers/rolloutController.js';
import { createSloController } from './api/controllers/sloController.js';
import { createAuditController } from './api/controllers/auditController.js';
import { createNodeController } from './api/controllers/nodeController.js';
import { createCohortController } from './api/controllers/cohortController.js';
import { createExperimentController } from './api/controllers/experimentController.js';
import { createAdapterController } from './api/controllers/adapterController.js';
import { createAgentController } from './api/controllers/agentController.js';
import { createPolicyController } from './api/controllers/policyController.js';
import { createAuthController } from './api/controllers/authController.js';
import { createSecurityController } from './api/controllers/securityController.js';
import { createRbacController } from './api/controllers/rbacController.js';
import { createSystemHealthController } from './api/controllers/systemHealthController.js';
import { enforceRbacPolicy, requireAuthenticatedOperator } from './api/middleware/auth.js';
import { loadOrCreateNodeIdentity, refreshInstanceId } from './core/nodeIdentity.js';
import { verifyLedgerIntegrity } from './core/auditLedger.js';
import { recordSystemApiRequest } from './core/systemHealthEngine.js';
import { loadRuntimeState, runtimeState } from './store/runtimeState.js';

const defaultAllowedOrigins = ['https://porta-operations-console.onrender.com', 'http://localhost:5173'];

function getAllowedOrigins(): Set<string> {
  const configured = process.env.CORS_ALLOWED_ORIGINS?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
  return new Set(configured.length > 0 ? configured : defaultAllowedOrigins);
}

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
  const allowedOrigins = getAllowedOrigins();

  app.use((req, res, next) => {
    const origin = req.header('origin');
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-operator-id,x-operator-role,Authorization');
    }

    if (req.method.toUpperCase() === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });

  app.use((_req, res, next) => {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    next();
  });

  app.use(express.json({ limit: '1mb' }));

  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ended = process.hrtime.bigint();
      const durationMs = Number(ended - started) / 1_000_000;
      recordSystemApiRequest({
        method: req.method.toUpperCase(),
        path: `${req.baseUrl}${req.path}`,
        status: res.statusCode,
        duration_ms: durationMs
      });
    });
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use('/auth', createAuthController());
  app.use('/api/agent', createAgentController());

  app.use('/v1', requireAuthenticatedOperator, enforceRbacPolicy);
  app.use('/v1/config', createConfigController());
  app.use('/v1/rollout', createRolloutController());
  app.use('/v1/slo', createSloController());
  app.use('/v1/nodes', createNodeController());
  app.use('/v1/cohorts', createCohortController());
  app.use('/v1/experiments', createExperimentController());
  app.use('/v1/adapter', createAdapterController());
  app.use('/v1/audit', createAuditController());
  app.use('/v1/policy', createPolicyController());
  app.use('/v1/security', createSecurityController());
  app.use('/v1/rbac', createRbacController());
  app.use('/v1/system', createSystemHealthController());

  return app;
}
