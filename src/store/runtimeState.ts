import { RolloutState } from '@porta/api-contracts';

export interface RuntimeState {
  currentConfigSeq: number;
  currentConfigVersion: string;
  previousConfigSeq?: number;
  appliedAtUtc?: string;
  rolloutState: RolloutState;
  cooldownUntilUtc?: string;
}

export const runtimeState: RuntimeState = {
  currentConfigSeq: 0,
  currentConfigVersion: 'bootstrap',
  rolloutState: 'IDLE'
};
