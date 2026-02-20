export interface ConfigEnvelope<TPayload = unknown> {
    configVersion: string;
    configSeq: number;
    issuedAt: string;
    expiresAt: string;
    issuerId: string;
    payload: TPayload;
    signature: string;
    signatureAlgorithm: 'ed25519' | 'ecdsa-p256';
}
