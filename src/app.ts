import express, { Express } from 'express';
import { createConfigController } from './api/controllers/configController.js';
import { createRolloutController } from './api/controllers/rolloutController.js';
import { createSloController } from './api/controllers/sloController.js';
import { createAuditController } from './api/controllers/auditController.js';
import { createNodeController } from './api/controllers/nodeController.js';
import { createMachineController } from './api/controllers/machineController.js';
import { createActionController } from './api/controllers/actionController.js';
import { createCohortController } from './api/controllers/cohortController.js';
import { createExperimentController } from './api/controllers/experimentController.js';
import { createAdapterController } from './api/controllers/adapterController.js';
import { createAgentController } from './api/controllers/agentController.js';
import { createCategoryController } from './api/controllers/categoryController.js';
import { createPolicyController } from './api/controllers/policyController.js';
import { createAuthController } from './api/controllers/authController.js';
import { createSecurityController } from './api/controllers/securityController.js';
import { createRbacController } from './api/controllers/rbacController.js';
import { createSystemHealthController } from './api/controllers/systemHealthController.js';
import { getBuildInfo } from './core/buildInfo.js';
import { createIdentityController } from './api/controllers/identityController.js';
import { createDeviceIdentityController } from './api/controllers/deviceIdentityController.js';
import { createClientReleaseController } from './api/controllers/clientReleaseController.js';
import { createGrowthController } from './api/controllers/growthController.js';
import { createDigestController } from './api/controllers/digestController.js';
import { enforceRbacPolicy, requireAuthenticatedOperator } from './api/middleware/auth.js';
import { loadOrCreateNodeIdentity, refreshInstanceId } from './core/nodeIdentity.js';
import { verifyLedgerIntegrity } from './core/auditLedger.js';
import { recordSystemApiRequest } from './core/systemHealthEngine.js';
import { assertFleetPersistenceConfigured, getFleetDatabaseUrl, getFleetPersistenceMode } from './store/fleetPersistence.js';
import { loadRuntimeState, runtimeState } from './store/runtimeState.js';

const defaultAllowedOrigins = ['https://porta-operations-console.onrender.com', 'http://localhost:5173'];

function getAllowedOrigins(): Set<string> {
  const configured = process.env.CORS_ALLOWED_ORIGINS?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
  return new Set(configured.length > 0 ? configured : defaultAllowedOrigins);
}

export function initializeControlPlane(): void {
  assertFleetPersistenceConfigured();
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
  console.log(
    `[control-plane] fleet_persistence=${getFleetPersistenceMode()} database_configured=${getFleetDatabaseUrl() !== null}`
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
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-operator-id,x-operator-role,x-operator-key,Authorization');
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

  // Answers "what is Render actually running?" without leaving the terminal. The agent's uptime
  // probe only reads ok, so adding fields here is additive and breaks no caller.
  app.get('/health', (_req, res) => {
    const build = getBuildInfo();
    res.json({
      ok: true,
      version: build.version,
      commit: build.commit,
      commit_short: build.commitShort,
      branch: build.branch,
      started_at_utc: build.startedAtUtc
    });
  });

  app.get('/launch', (req, res) => {
    const ua = req.headers['user-agent'] ?? '';
    const isMobile = /android|iphone|ipad|ipod|mobile|blackberry|windows phone/i.test(ua);

    // Override the restrictive default CSP — this page serves HTML with inline styles/scripts
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    if (isMobile) {
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ari by Porta</title>
</head>
<body style="margin:0;padding:0;background:#0a0a10;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;">
<div style="max-width:380px;padding:40px 28px;text-align:center;">
  <div style="width:64px;height:64px;background:#1e1e32;border-radius:16px;margin:0 auto 28px;display:flex;align-items:center;justify-content:center;">
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="32" height="32" rx="8" fill="#3d3d7a"/>
      <circle cx="16" cy="16" r="7" stroke="#a0a0d0" stroke-width="2" fill="none"/>
      <line x1="16" y1="10" x2="16" y2="16" stroke="#a0a0d0" stroke-width="2" stroke-linecap="round"/>
      <circle cx="16" cy="16" r="1.5" fill="#a0a0d0"/>
    </svg>
  </div>
  <h1 style="font-size:22px;font-weight:700;color:#dde1ef;margin:0 0 14px;letter-spacing:-0.3px;">Ari runs on your PC</h1>
  <p style="font-size:15px;color:#6a6a88;line-height:1.7;margin:0 0 12px;">PORTA is a Windows desktop app — it can't open on your phone.</p>
  <p style="font-size:15px;color:#6a6a88;line-height:1.7;margin:0 0 32px;">Open this email on your Windows computer and click the button there to launch the Control Center.</p>
  <p style="font-size:12px;color:#2e2e48;margin:0;">Ari by Porta &middot; desktop focus intelligence</p>
</div>
</body>
</html>`);
    } else {
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Opening Ari&hellip;</title>
</head>
<body style="margin:0;padding:0;background:#0a0a10;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;">
<div style="max-width:380px;padding:40px 28px;text-align:center;">
  <div style="width:64px;height:64px;background:#1e1e32;border-radius:16px;margin:0 auto 28px;display:flex;align-items:center;justify-content:center;">
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="32" height="32" rx="8" fill="#3d3d7a"/>
      <circle cx="16" cy="16" r="7" stroke="#a0a0d0" stroke-width="2" fill="none"/>
      <line x1="16" y1="10" x2="16" y2="16" stroke="#a0a0d0" stroke-width="2" stroke-linecap="round"/>
      <circle cx="16" cy="16" r="1.5" fill="#a0a0d0"/>
    </svg>
  </div>
  <h1 style="font-size:22px;font-weight:700;color:#dde1ef;margin:0 0 14px;letter-spacing:-0.3px;" id="heading">Opening Ari&hellip;</h1>
  <p style="font-size:15px;color:#6a6a88;line-height:1.7;margin:0 0 28px;" id="sub">Launching the Control Center on your PC.</p>
  <a href="porta://open" style="display:inline-block;background:#2a2a5a;color:#a0a0d0;text-decoration:none;font-size:14px;font-weight:600;padding:12px 32px;border-radius:8px;border:1px solid #3d3d7a;letter-spacing:0.04em;">Open Ari manually</a>
  <p style="font-size:12px;color:#2e2e48;margin:24px 0 0;">Nothing happened? Make sure PORTA is installed and running on your PC.</p>
</div>
<script>
  try { window.location.href = 'porta://open'; } catch(e) {}
  setTimeout(function() {
    var h = document.getElementById('heading');
    var s = document.getElementById('sub');
    if (h) h.textContent = 'Ari launched';
    if (s) s.textContent = 'The Control Center should now be open on your screen.';
  }, 1500);
</script>
</body>
</html>`);
    }
  });

  app.use('/auth', createAuthController());
  app.use('/api/agent', createAgentController());
  app.use('/api/device', createDeviceIdentityController());
  app.use('/api/client-release', createClientReleaseController());

  app.use('/v1', requireAuthenticatedOperator, enforceRbacPolicy);
  app.use('/v1/config', createConfigController());
  app.use('/v1/rollout', createRolloutController());
  app.use('/v1/slo', createSloController());
  app.use('/v1', createIdentityController());
  app.use('/v1/nodes', createNodeController());
  app.use('/v1/machines', createMachineController());
  app.use('/v1/actions', createActionController());
  app.use('/v1/growth', createGrowthController());
  app.use('/v1/digest', createDigestController());
  app.use('/v1/cohorts', createCohortController());
  app.use('/v1/experiments', createExperimentController());
  app.use('/v1/adapter', createAdapterController());
  app.use('/v1/audit', createAuditController());
  app.use('/v1/policy', createPolicyController());
  app.use('/v1/security', createSecurityController());
  app.use('/v1/rbac', createRbacController());
  app.use('/v1/system', createSystemHealthController());
  app.use('/v1/categories', createCategoryController());

  return app;
}
