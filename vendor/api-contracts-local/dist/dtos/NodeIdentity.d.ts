export type CohortId = 'stable' | 'canary-1' | 'canary-5' | 'internal' | 'experimental';
export interface NodeIdentity {
    nodeId: string;
    clusterId: string;
    instanceId: string;
    hardwareFingerprint?: string;
    cohortId: CohortId;
    cohortBucket: number;
}
