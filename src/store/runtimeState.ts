import fs from 'node:fs';
import path from 'node:path';
import { RolloutState } from '@porta/api-contracts';

export interface RuntimeState {
  currentConfigSeq: number;
  currentConfigVersion: string;
  previousConfigSeq?: number;
  appliedAtUtc?: string;
  rolloutState: RolloutState;
  cooldownUntilUtc?: string;
}

const statePath = path.resolve('.data', 'runtime-state.json');

const defaultState: RuntimeState = {
  currentConfigSeq: 0,
  currentConfigVersion: 'bootstrap',
  rolloutState: 'IDLE'
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
    previousConfigSeq: Number.isInteger(candidate.previousConfigSeq) ? Number(candidate.previousConfigSeq) : undefined,
    appliedAtUtc: typeof candidate.appliedAtUtc === 'string' ? candidate.appliedAtUtc : undefined,
    rolloutState: typeof candidate.rolloutState === 'string' ? (candidate.rolloutState as RolloutState) : 'IDLE',
    cooldownUntilUtc: typeof candidate.cooldownUntilUtc === 'string' ? candidate.cooldownUntilUtc : undefined
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
