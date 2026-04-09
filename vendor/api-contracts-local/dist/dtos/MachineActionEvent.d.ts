export type MachineActionCategory = 'suggestion' | 'automatic_change' | 'policy_intent' | 'unsupported' | 'decision_record';
export type MachineActionDecisionState = 'decided';
export type MachineActionExecutionState = 'decision_only' | 'decided' | 'applied' | 'verified' | 'overlay_started' | 'accepted' | 'dismissed' | 'skipped' | 'snoozed' | 'suppressed_by_preference' | 'overlay_recovered' | 'overlay_completed' | 'overlay_aborted' | 'failed';
export type MachineActionVerifiedState = 'not_applicable' | 'pending' | 'unverified' | 'verified';
export interface MachineActionEvent {
    deviceId: string;
    machineId: string;
    accountId?: string | null;
    orgId?: string | null;
    userName: string;
    interventionId: string;
    action: string;
    actionCategory: MachineActionCategory;
    decisionState: MachineActionDecisionState;
    executionState: MachineActionExecutionState;
    verifiedState: MachineActionVerifiedState;
    timestampUtc: string;
    appliedAtUtc?: string | null;
    errorCode?: string | null;
    deliverySurface?: string | null;
    interactionKind?: string | null;
    breakKind?: string | null;
    promptOutcome?: string | null;
    overlayState?: string | null;
    policyId: string;
    whatChanged?: string | null;
    howToUndo?: string | null;
}
