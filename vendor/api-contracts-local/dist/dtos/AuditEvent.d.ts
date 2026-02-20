export interface AuditEvent {
    eventId: string;
    actorId: string;
    action: string;
    target: string;
    occurredAtUtc: string;
    metadata?: Record<string, string | number | boolean | null>;
}
