export type CaptureContext = 'Unknown' | 'UserSession' | 'ServiceSession';
export type ContinuityState = 'keep' | 'pause' | 'decay' | 'reset';
export type CalibrationStage = 'cold' | 'provisional' | 'calibrated';
export type TrustTier = 'low' | 'medium' | 'high';
export type AttentionSegmentKind = 'focus' | 'context_excursion' | 'off_task_distraction' | 'fragmentation_distraction' | 'away';
export type BreakKind = 'short_break' | 'long_break';
export interface MachineSummaryReport {
    deviceId: string;
    machineId: string;
    accountId?: string | null;
    orgId?: string | null;
    machineName: string;
    userName: string;
    agentVersion: string;
    schemaVersion: string;
    policyVersion: string;
    reportedAtUtc: string;
    agentRunning: boolean;
    userSessionConnected: boolean;
    activityDetected: boolean;
    lastActivityUtc?: string | null;
    userAgentHeartbeatUtc?: string | null;
    userAgentHeartbeatAgeSeconds?: number | null;
    lastAcceptedInputAgeSeconds?: number | null;
    userAgentStartupSource?: string | null;
    userAgentStartupState?: string | null;
    userAgentLastLaunchReason?: string | null;
    userAgentHeartbeatWriteFailureCount?: number | null;
    captureContext: CaptureContext;
    keyboardSignalActive: boolean;
    mouseSignalActive: boolean;
    ownershipWarning?: string | null;
    captureFailureReason?: string | null;
    lastError?: string | null;
    backendConnected: boolean;
    localApiAuthReady: boolean;
    dbMigrationFailed: boolean;
    focusEpisodeQuality: number;
    focusEpisodeSeconds: number;
    focusEpisodeState: ContinuityState;
    focusEpisodeReasonCode?: string | null;
    focusEpisodeReasonText?: string | null;
    attentionSegmentKind: AttentionSegmentKind;
    attentionSegmentSeconds: number;
    attentionSegmentReasonCode?: string | null;
    attentionSegmentReasonText?: string | null;
    distractionEpisodeActive: boolean;
    distractionEpisodeSeconds: number;
    taskContinuityScore: number;
    taskContinuitySeconds: number;
    continuityState: ContinuityState;
    deepWorkActive: boolean;
    pressureLevel: number;
    pressureConfidence: number;
    overloadLikelihood: number;
    overloadActive: boolean;
    breakNeeded: boolean;
    breakPendingKind?: BreakKind | null;
    breakPendingAction?: string | null;
    breakPendingReasonCode?: string | null;
    calibrationStage: CalibrationStage;
    trustTier: TrustTier;
    modelConfidence: number;
    signalQualityScore?: number | null;
    partialData: boolean;
    missingMajorChannels: string[];
    /**
     * Diagnostic-only: WTS connect-state of the session the user-agent runs in
     * ("active", "disconnected", "idle", ...). Used to tell apart a connected-but-blind
     * machine (fixable foreground/desktop bug) from a disconnected RDP session
     * (no foreground exists). Optional; older agents do not send it.
     */
    userAgentSessionConnectState?: string | null;
}
