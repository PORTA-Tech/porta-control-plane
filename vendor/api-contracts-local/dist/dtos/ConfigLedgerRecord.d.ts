export interface ConfigLedgerRecord<TPayload = unknown> {
    configSeq: number;
    configVersion: string;
    appliedAtUtc: string;
    issuerId: string;
    payload: TPayload;
    diffFromPrevious?: string;
    previousConfigSeq?: number;
    approvalTicket?: string;
    rolloutStatus: 'pending' | 'promoting' | 'halted' | 'rolled_back' | 'completed';
    hash: string;
    previousHash?: string;
}
