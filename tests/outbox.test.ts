import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { appendOperatorAuditEvent } from '../src/core/operatorAudit.js';
import { dispatchOutbox, getOutboxStatus, readOutboxRecords } from '../src/core/outbox.js';

const dataDir = path.resolve('.data');

describe('outbox', () => {
  beforeEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('enqueues outbox records when audit events are appended', () => {
    appendOperatorAuditEvent('operator-a', 'rollout.transition', 'rollout_state_machine', { to: 'PROMOTING' });

    const records = readOutboxRecords();
    expect(records.length).toBe(1);
    expect(records[0].topic).toBe('audit.event');
    expect(records[0].dedupeKey).toBeTruthy();
  });

  it('dispatches pending records once and keeps idempotent state on re-dispatch', () => {
    appendOperatorAuditEvent('operator-a', 'rollout.transition', 'rollout_state_machine', { to: 'PROMOTING' });
    appendOperatorAuditEvent('operator-a', 'rollout.transition', 'rollout_state_machine', { to: 'MONITORING' });

    const first = dispatchOutbox(100);
    expect(first.delivered).toBe(2);
    expect(first.failed).toBe(0);

    const second = dispatchOutbox(100);
    expect(second.delivered).toBe(0);
    expect(second.skipped).toBe(2);
    expect(second.failed).toBe(0);

    const status = getOutboxStatus();
    expect(status.queued).toBe(2);
    expect(status.delivered).toBe(2);
    expect(status.pending).toBe(0);
  });
});
