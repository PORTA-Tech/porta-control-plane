import { Router } from 'express';
import type { CohortId } from '@porta/api-contracts';
import { runtimeState, persistRuntimeState } from '../../store/runtimeState.js';
import type { OperatorRequest } from '../middleware/auth.js';
import { appendOperatorAuditEvent } from '../../core/operatorAudit.js';
import { readOperatorAuditEvents } from '../../core/operatorAudit.js';

type AdapterControlsUpdate = {
  feature_adapter_enabled: boolean;
  allowed_cohorts: CohortId[];
  rate_limit: number;
  circuit_breaker_threshold: number;
  schema_version: string;
};

type AdapterPromotionStage = 'CANARY' | 'LIMITED' | 'MAJORITY' | 'FULL';

function featureGateEnabled(): boolean {
  const raw = process.env.CONTROL_PLANE_ADAPTER_EXPANSION_ENABLED ?? 'false';
  return raw === '1' || raw.toLowerCase() === 'true';
}

function toView() {
  return {
    feature_adapter_enabled: runtimeState.adapterControls.featureAdapterEnabled,
    allowed_cohorts: runtimeState.adapterControls.allowedCohorts,
    rate_limit: runtimeState.adapterControls.rateLimit,
    circuit_breaker_threshold: runtimeState.adapterControls.circuitBreakerThreshold,
    schema_version: runtimeState.adapterControls.schemaVersion,
    feature_gate_enabled: featureGateEnabled(),
    rollout_state: runtimeState.rolloutState,
    updated_at_utc: new Date().toISOString()
  };
}

const promotionOrder: AdapterPromotionStage[] = ['CANARY', 'LIMITED', 'MAJORITY', 'FULL'];

function nextStage(stage: AdapterPromotionStage): AdapterPromotionStage | null {
  const index = promotionOrder.indexOf(stage);
  if (index < 0 || index === promotionOrder.length - 1) return null;
  return promotionOrder[index + 1];
}

function allowedCohortsForStage(stage: AdapterPromotionStage): CohortId[] {
  if (stage === 'CANARY') return ['canary-1'];
  if (stage === 'LIMITED') return ['canary-1', 'canary-5'];
  if (stage === 'MAJORITY') return ['canary-1', 'canary-5', 'stable'];
  return ['stable', 'canary-1', 'canary-5', 'internal', 'experimental'];
}

function evaluateObservabilitySloGate(allowedCohorts: CohortId[]): { ok: boolean; reasons: string[] } {
  const baseByCohort: Record<CohortId, { error: number; latency: number }> = {
    stable: { error: 0.06, latency: 43 },
    'canary-1': { error: 0.19, latency: 58 },
    'canary-5': { error: 0.31, latency: 66 },
    internal: { error: 0.04, latency: 38 },
    experimental: { error: 0.58, latency: 87 }
  };

  const reasons: string[] = [];
  for (const cohort of allowedCohorts) {
    const metrics = baseByCohort[cohort];
    if (metrics.error >= 1.0) reasons.push(`slo_error_rate_exceeded:${cohort}`);
    if (metrics.latency >= 300) reasons.push(`slo_latency_exceeded:${cohort}`);
  }

  return { ok: reasons.length === 0, reasons };
}

function promotionPathView(advanced: boolean): {
  stage: AdapterPromotionStage;
  next_stage: AdapterPromotionStage | null;
  advanced: boolean;
  allowed_to_advance: boolean;
  guard_reasons: string[];
  rollout_state: string;
  cooldown_active: boolean;
  updated_at_utc: string;
} {
  const stage = runtimeState.adapterControls.promotionStage;
  const next = nextStage(stage);
  const guardReasons: string[] = [];

  if (!featureGateEnabled()) guardReasons.push('feature_gate_disabled');
  if (!runtimeState.adapterControls.featureAdapterEnabled) guardReasons.push('adapter_not_enabled');
  if (runtimeState.rolloutState !== 'PROMOTING' && runtimeState.rolloutState !== 'MONITORING') {
    guardReasons.push('rollout_fsm_blocked');
  }
  const cooldownActive = !!runtimeState.cooldownUntilUtc && Date.parse(runtimeState.cooldownUntilUtc) > Date.now();
  if (cooldownActive) guardReasons.push('cooldown_active');
  if (!next) guardReasons.push('already_full');
  const sloGate = evaluateObservabilitySloGate(runtimeState.adapterControls.allowedCohorts);
  guardReasons.push(...sloGate.reasons);

  return {
    stage,
    next_stage: next,
    advanced,
    allowed_to_advance: guardReasons.length === 0,
    guard_reasons: guardReasons,
    rollout_state: runtimeState.rolloutState,
    cooldown_active: cooldownActive,
    updated_at_utc: new Date().toISOString()
  };
}

function isValidUpdate(input: AdapterControlsUpdate): boolean {
  return (
    typeof input.feature_adapter_enabled === 'boolean' &&
    Array.isArray(input.allowed_cohorts) &&
    input.allowed_cohorts.length > 0 &&
    Number.isInteger(input.rate_limit) &&
    input.rate_limit > 0 &&
    Number.isInteger(input.circuit_breaker_threshold) &&
    input.circuit_breaker_threshold > 0 &&
    typeof input.schema_version === 'string' &&
    input.schema_version.trim().length > 0
  );
}

export function createAdapterController(): Router {
  const router = Router();

  router.get('/controls', (_req, res) => {
    res.json(toView());
  });

  router.post('/controls', (req: OperatorRequest, res) => {
    if (!featureGateEnabled()) {
      res.status(412).json({ error: 'adapter_feature_gate_disabled' });
      return;
    }

    const actorId = req.operatorId ?? 'unknown';
    const input = req.body as AdapterControlsUpdate;
    if (!isValidUpdate(input)) {
      res.status(400).json({ error: 'invalid_adapter_controls_payload' });
      return;
    }

    const currentlyEnabled = runtimeState.adapterControls.featureAdapterEnabled;
    const enablingNow = !currentlyEnabled && input.feature_adapter_enabled;
    if (enablingNow && runtimeState.rolloutState !== 'PROMOTING') {
      appendOperatorAuditEvent(actorId, 'adapter.activation_blocked', 'adapter_controls', {
        reason: 'fsm_bypass_blocked',
        fromState: runtimeState.rolloutState
      });
      res.status(409).json({
        error: 'adapter_activation_requires_promoting_state',
        rollout_state: runtimeState.rolloutState
      });
      return;
    }

    runtimeState.adapterControls = {
      featureAdapterEnabled: input.feature_adapter_enabled,
      allowedCohorts: input.allowed_cohorts,
      rateLimit: input.rate_limit,
      circuitBreakerThreshold: input.circuit_breaker_threshold,
      schemaVersion: input.schema_version,
      promotionStage: runtimeState.adapterControls.promotionStage
    };
    persistRuntimeState();

    appendOperatorAuditEvent(actorId, 'adapter.controls_updated', 'adapter_controls', {
      featureAdapterEnabled: runtimeState.adapterControls.featureAdapterEnabled,
      allowedCohorts: runtimeState.adapterControls.allowedCohorts.join(','),
      rateLimit: runtimeState.adapterControls.rateLimit,
      circuitBreakerThreshold: runtimeState.adapterControls.circuitBreakerThreshold,
      schemaVersion: runtimeState.adapterControls.schemaVersion
    });

    res.json(toView());
  });

  router.get('/observability', (_req, res) => {
    const cohorts: CohortId[] = ['stable', 'canary-1', 'canary-5', 'internal', 'experimental'];
    const baseByCohort: Record<CohortId, { error: number; latency: number }> = {
      stable: { error: 0.06, latency: 43 },
      'canary-1': { error: 0.19, latency: 58 },
      'canary-5': { error: 0.31, latency: 66 },
      internal: { error: 0.04, latency: 38 },
      experimental: { error: 0.58, latency: 87 }
    };

    const rows = cohorts.map((cohort) => {
      const selected = baseByCohort[cohort];
      const enabledForCohort =
        runtimeState.adapterControls.featureAdapterEnabled && runtimeState.adapterControls.allowedCohorts.includes(cohort);
      const errorRate = enabledForCohort ? selected.error : 0;
      const latency = enabledForCohort ? selected.latency : 0;
      const threshold = runtimeState.adapterControls.circuitBreakerThreshold;
      const circuitBreakerState: 'CLOSED' | 'OPEN' | 'HALF_OPEN' =
        !enabledForCohort ? 'CLOSED' : errorRate >= threshold ? 'OPEN' : errorRate >= threshold * 0.8 ? 'HALF_OPEN' : 'CLOSED';

      return {
        cohort,
        adapter_error_rate_pct: Number(errorRate.toFixed(3)),
        adapter_latency_ms: Number(latency.toFixed(2)),
        circuit_breaker_state: circuitBreakerState,
        sampled_at_utc: new Date().toISOString()
      };
    });

    res.json(rows);
  });

  router.get('/promotion-path', (_req, res) => {
    res.json(promotionPathView(false));
  });

  router.post('/promotion-path', (req: OperatorRequest, res) => {
    const actorId = req.operatorId ?? 'unknown';
    const view = promotionPathView(false);
    if (!view.allowed_to_advance || !view.next_stage) {
      appendOperatorAuditEvent(actorId, 'adapter.promotion_blocked', 'adapter_promotion_path', {
        reasons: view.guard_reasons.join(','),
        stage: view.stage
      });
      res.json(view);
      return;
    }

    runtimeState.adapterControls.promotionStage = view.next_stage;
    runtimeState.adapterControls.allowedCohorts = allowedCohortsForStage(view.next_stage);
    persistRuntimeState();

    appendOperatorAuditEvent(actorId, 'adapter.promotion_advanced', 'adapter_promotion_path', {
      fromStage: view.stage,
      toStage: view.next_stage
    });
    res.json(promotionPathView(true));
  });

  router.get('/replay-log', (req, res) => {
    const cohort = req.query.cohort as CohortId | undefined;
    if (!cohort) {
      res.status(400).json({ error: 'cohort_required' });
      return;
    }

    const limitRaw = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.trunc(limitRaw))) : 50;

    const rows = readOperatorAuditEvents(1000)
      .filter((event) => {
        const meta = event.metadata;
        if (!meta || typeof meta !== 'object') return false;
        const metaCohort =
          (meta.cohort as string | undefined) ??
          (meta.cohortId as string | undefined) ??
          (meta.targetCohort as string | undefined);
        return metaCohort === cohort;
      })
      .slice(-limit)
      .reverse()
      .map((event) => ({
        event_id: event.eventId,
        cohort,
        timestamp_utc: event.occurredAtUtc,
        action: event.action,
        outcome:
          event.action.includes('rejected') || event.action.includes('blocked')
            ? 'blocked'
            : event.action.includes('rollback')
              ? 'rollback'
              : 'applied',
        correlation_id: event.eventId
      }));

    res.json(rows);
  });

  return router;
}
