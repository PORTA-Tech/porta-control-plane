import fs from 'node:fs';
import path from 'node:path';
import { RolloutState } from '@porta/api-contracts';

export interface RuntimeState {
  currentConfigSeq: number;
  currentConfigVersion: string;
  currentConfigIssuerId: string | undefined;
  currentConfigExpiresAtUtc: string | undefined;
  currentConfigSignatureValid: boolean | undefined;
  previousConfigSeq: number | undefined;
  previousConfigVersion: string | undefined;
  appliedAtUtc: string | undefined;
  rolloutState: RolloutState;
  cooldownUntilUtc: string | undefined;
  rolloutValidationReport: unknown;
  adapterControls: {
    featureAdapterEnabled: boolean;
    allowedCohorts: ('stable' | 'canary-1' | 'canary-5' | 'internal' | 'experimental')[];
    rateLimit: number;
    circuitBreakerThreshold: number;
    schemaVersion: string;
    promotionStage: 'CANARY' | 'LIMITED' | 'MAJORITY' | 'FULL';
  };
}

const statePath = path.resolve('.data', 'runtime-state.json');

const defaultState: RuntimeState = {
  currentConfigSeq: 0,
  currentConfigVersion: 'bootstrap',
  currentConfigIssuerId: undefined,
  currentConfigExpiresAtUtc: undefined,
  currentConfigSignatureValid: undefined,
  previousConfigSeq: undefined,
  previousConfigVersion: undefined,
  appliedAtUtc: undefined,
  rolloutState: 'IDLE',
  cooldownUntilUtc: undefined,
  rolloutValidationReport: undefined,
  adapterControls: {
    featureAdapterEnabled: false,
    allowedCohorts: ['canary-1'],
    rateLimit: 100,
    circuitBreakerThreshold: 5,
    schemaVersion: '1.0.0',
    promotionStage: 'CANARY'
  }
};

export const runtimeState: RuntimeState = { ...defaultState };

function toRuntimeState(raw: unknown): RuntimeState {
  if (!raw || typeof raw !== 'object') {
    return { ...defaultState };
  }

  const candidate = raw as Partial<RuntimeState>;
  return {
    currentConfigSeq: Number.isInteger(candidate.currentConfigSeq) ? Number(candidate.currentConfigSeq) : 0,
    currentConfigVersion: typeof candidate.currentConfigVersion === 'string' ? candidate.currentConfigVersion : 'bootstrap',
    currentConfigIssuerId: typeof candidate.currentConfigIssuerId === 'string' ? candidate.currentConfigIssuerId : undefined,
    currentConfigExpiresAtUtc:
      typeof candidate.currentConfigExpiresAtUtc === 'string' ? candidate.currentConfigExpiresAtUtc : undefined,
    currentConfigSignatureValid:
      typeof candidate.currentConfigSignatureValid === 'boolean' ? candidate.currentConfigSignatureValid : undefined,
    previousConfigSeq: Number.isInteger(candidate.previousConfigSeq) ? Number(candidate.previousConfigSeq) : undefined,
    previousConfigVersion: typeof candidate.previousConfigVersion === 'string' ? candidate.previousConfigVersion : undefined,
    appliedAtUtc: typeof candidate.appliedAtUtc === 'string' ? candidate.appliedAtUtc : undefined,
    rolloutState: typeof candidate.rolloutState === 'string' ? (candidate.rolloutState as RolloutState) : 'IDLE',
    cooldownUntilUtc: typeof candidate.cooldownUntilUtc === 'string' ? candidate.cooldownUntilUtc : undefined,
    rolloutValidationReport: candidate.rolloutValidationReport,
    adapterControls:
      candidate.adapterControls && typeof candidate.adapterControls === 'object'
        ? {
            featureAdapterEnabled:
              typeof candidate.adapterControls.featureAdapterEnabled === 'boolean'
                ? candidate.adapterControls.featureAdapterEnabled
                : false,
            allowedCohorts:
              Array.isArray(candidate.adapterControls.allowedCohorts) &&
              candidate.adapterControls.allowedCohorts.every((value) => typeof value === 'string')
                ? (candidate.adapterControls.allowedCohorts as RuntimeState['adapterControls']['allowedCohorts'])
                : ['canary-1'],
            rateLimit:
              typeof candidate.adapterControls.rateLimit === 'number' && Number.isFinite(candidate.adapterControls.rateLimit)
                ? Math.max(1, Math.trunc(candidate.adapterControls.rateLimit))
                : 100,
            circuitBreakerThreshold:
              typeof candidate.adapterControls.circuitBreakerThreshold === 'number' &&
              Number.isFinite(candidate.adapterControls.circuitBreakerThreshold)
                ? Math.max(1, Math.trunc(candidate.adapterControls.circuitBreakerThreshold))
                : 5,
            schemaVersion:
              typeof candidate.adapterControls.schemaVersion === 'string'
                ? candidate.adapterControls.schemaVersion
                : '1.0.0',
            promotionStage:
              candidate.adapterControls.promotionStage === 'LIMITED' ||
              candidate.adapterControls.promotionStage === 'MAJORITY' ||
              candidate.adapterControls.promotionStage === 'FULL'
                ? candidate.adapterControls.promotionStage
                : 'CANARY'
          }
        : { ...defaultState.adapterControls }
  };
}

export function loadRuntimeState(): RuntimeState {
  if (!fs.existsSync(statePath)) {
    return runtimeState;
  }

  const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const loaded = toRuntimeState(parsed);
  Object.assign(runtimeState, loaded);
  return runtimeState;
}

export function persistRuntimeState(): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(runtimeState, null, 2));
  fs.renameSync(tmpPath, statePath);
}

export function resetRuntimeStateForTests(): void {
  Object.assign(runtimeState, defaultState);
}
