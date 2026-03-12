import { Router } from 'express';
import { runtimeState } from '../../store/runtimeState.js';
import { OperatorRequest } from '../middleware/auth.js';
import { RolloutTransitionError, clearCooldownIfElapsed, transitionRolloutState } from '../../core/rolloutStateMachine.js';
import { executeAutoHaltRollback } from '../../core/rolloutAutomation.js';
import type { CohortId, RolloutState } from '@porta/api-contracts';
import { buildRolloutEvidencePack, evaluateRollout } from '../../core/rolloutEvaluationEngine.js';
import {
  RolloutValidationError,
  readRolloutValidationReport,
  upsertRolloutValidationReport
} from '../../core/rolloutValidationStore.js';

function buildDryRunView(state: RolloutState): {
  blast_radius_node_count: number;
  cohorts_impacted: CohortId[];
  predicted_slo_impact: {
    error_rate_delta_pct: number;
    p99_latency_delta_ms: number;
    degradation_rate_delta_pct: number;
  };
  rollout_stage_progression_preview: RolloutState[];
  generated_at_utc: string;
} {
  const viewByState: Record<
    RolloutState,
    {
      blastRadius: number;
      cohorts: CohortId[];
      impact: { error: number; latency: number; degradation: number };
      progression: RolloutState[];
    }
  > = {
    IDLE: {
      blastRadius: 10,
      cohorts: ['canary-1'],
      impact: { error: 0.08, latency: 14, degradation: 0.22 },
      progression: ['PROMOTING', 'MONITORING', 'IDLE']
    },
    PROMOTING: {
      blastRadius: 50,
      cohorts: ['canary-1', 'canary-5'],
      impact: { error: 0.17, latency: 26, degradation: 0.44 },
      progression: ['MONITORING', 'IDLE']
    },
    MONITORING: {
      blastRadius: 940,
      cohorts: ['stable'],
      impact: { error: 0.29, latency: 43, degradation: 0.71 },
      progression: ['PROMOTING', 'MONITORING', 'IDLE']
    },
    HALTED: {
      blastRadius: 940,
      cohorts: ['stable'],
      impact: { error: 0.51, latency: 88, degradation: 1.38 },
      progression: ['ROLLED_BACK', 'COOLDOWN', 'IDLE']
    },
    ROLLED_BACK: {
      blastRadius: 940,
      cohorts: ['stable'],
      impact: { error: -0.11, latency: -12, degradation: -0.31 },
      progression: ['COOLDOWN', 'IDLE']
    },
    COOLDOWN: {
      blastRadius: 0,
      cohorts: [],
      impact: { error: -0.05, latency: -8, degradation: -0.14 },
      progression: ['IDLE']
    }
  };

  const selected = viewByState[state];
  return {
    blast_radius_node_count: selected.blastRadius,
    cohorts_impacted: selected.cohorts,
    predicted_slo_impact: {
      error_rate_delta_pct: selected.impact.error,
      p99_latency_delta_ms: selected.impact.latency,
      degradation_rate_delta_pct: selected.impact.degradation
    },
    rollout_stage_progression_preview: selected.progression,
    generated_at_utc: new Date().toISOString()
  };
}

export function createRolloutController(): Router {
  const router = Router();

  router.get('/state', (_req, res) => {
    clearCooldownIfElapsed();
    res.json({
      state: runtimeState.rolloutState,
      activeConfigSeq: runtimeState.currentConfigSeq,
      cooldownUntilUtc: runtimeState.cooldownUntilUtc,
      updatedAtUtc: new Date().toISOString()
    });
  });

  router.get('/dry-run', (_req, res) => {
    clearCooldownIfElapsed();
    res.json(buildDryRunView(runtimeState.rolloutState));
  });

  router.get('/evaluate', (req, res) => {
    clearCooldownIfElapsed();
    const actorId = (req as OperatorRequest).operatorId ?? 'operator-unknown';
    res.json(evaluateRollout(actorId));
  });

  router.get('/validation-gates', (_req, res) => {
    clearCooldownIfElapsed();
    const report = readRolloutValidationReport();
    if (!report) {
      res.status(404).json({ error_code: 'VALIDATION_REPORT_NOT_FOUND', message: 'No rollout validation report has been published yet.' });
      return;
    }

    res.json(report);
  });

  router.post('/validation-gates', (req: OperatorRequest, res) => {
    clearCooldownIfElapsed();
    const actorId = req.operatorId ?? 'unknown';

    try {
      const report = upsertRolloutValidationReport(req.body ?? {}, actorId);
      res.status(201).json(report);
    } catch (error) {
      if (error instanceof RolloutValidationError) {
        res.status(error.status).json({ error_code: error.code, message: error.message });
        return;
      }

      throw error;
    }
  });

  router.get('/evidence-pack', (req, res) => {
    clearCooldownIfElapsed();
    const actorId = (req as OperatorRequest).operatorId ?? 'operator-unknown';
    const limitRaw = Number(req.query.limit ?? 200);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.trunc(limitRaw))) : 200;
    res.json(buildRolloutEvidencePack(actorId, limit));
  });

  router.post('/promote', (req: OperatorRequest, res) => {
    const actorId = req.operatorId ?? 'unknown';
    clearCooldownIfElapsed();
    try {
      const transition = transitionRolloutState('PROMOTING', actorId, 'operator_promote');
      res.status(transition.idempotent ? 200 : 202).json({
        state: runtimeState.rolloutState,
        transition
      });
    } catch (error) {
      if (error instanceof RolloutTransitionError) {
        res.status(409).json({ error: error.code, from: error.from, to: error.to });
        return;
      }

      throw error;
    }
  });

  router.post('/halt', (req: OperatorRequest, res) => {
    const actorId = req.operatorId ?? 'unknown';
    clearCooldownIfElapsed();
    try {
      const transition = transitionRolloutState('HALTED', actorId, 'operator_halt');
      res.status(transition.idempotent ? 200 : 202).json({
        state: runtimeState.rolloutState,
        transition
      });
    } catch (error) {
      if (error instanceof RolloutTransitionError) {
        res.status(409).json({ error: error.code, from: error.from, to: error.to });
        return;
      }

      throw error;
    }
  });

  router.post('/rollback', (req: OperatorRequest, res) => {
    const actorId = req.operatorId ?? 'unknown';
    clearCooldownIfElapsed();
    try {
      const result = executeAutoHaltRollback(actorId, 'operator_forced');
      res.status(result.actionTaken ? 202 : 200).json({
        state: runtimeState.rolloutState,
        actionTaken: result.actionTaken,
        rollbackApplied: result.rollbackApplied,
        reason: result.reason,
        fromState: result.fromState,
        toState: result.toState,
        cooldownUntilUtc: runtimeState.cooldownUntilUtc
      });
    } catch (error) {
      if (error instanceof RolloutTransitionError) {
        res.status(409).json({ error: error.code, from: error.from, to: error.to });
        return;
      }

      throw error;
    }
  });

  return router;
}
