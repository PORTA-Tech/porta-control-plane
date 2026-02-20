export type RolloutState = 'IDLE' | 'PROMOTING' | 'MONITORING' | 'HALTED' | 'ROLLED_BACK' | 'COOLDOWN';
export interface RolloutStatusView {
    state: RolloutState;
    activeConfigSeq: number;
    targetCohort?: string;
    cooldownUntilUtc?: string;
    updatedAtUtc: string;
}
