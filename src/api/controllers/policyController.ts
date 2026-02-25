import { Router } from 'express';
import { evaluatePolicyEngine, getPolicyEngineState } from '../../core/policyExecutionEngine.js';

export function createPolicyController(): Router {
  const router = Router();

  router.post('/evaluate', (req, res) => {
    const body = req.body as {
      environment?: string;
      service?: string;
      region?: string;
      metrics?: Array<{
        schema_name: string;
        metric_name: string;
        aggregation: 'avg' | 'p95' | 'p99' | 'max' | 'min';
        window_seconds: number;
        value: number;
      }>;
      timestamp?: string;
      correlation_id?: string;
      kill_switch_enabled?: boolean;
    };

    if (!body?.environment || !Array.isArray(body.metrics)) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const result = evaluatePolicyEngine({
      environment: body.environment,
      metrics: body.metrics,
      ...(body.service ? { service: body.service } : {}),
      ...(body.region ? { region: body.region } : {}),
      ...(body.timestamp ? { timestamp: body.timestamp } : {}),
      ...(body.correlation_id ? { correlation_id: body.correlation_id } : {}),
      ...(typeof body.kill_switch_enabled === 'boolean' ? { kill_switch_enabled: body.kill_switch_enabled } : {})
    });
    res.json(result);
  });

  router.get('/state/:environment/:service', (req, res) => {
    const state = getPolicyEngineState(req.params.environment, req.params.service);
    if (!state) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(state);
  });

  return router;
}
