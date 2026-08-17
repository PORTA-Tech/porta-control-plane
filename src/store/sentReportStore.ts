import { ensureFleetPersistenceReady, getFleetPersistenceMode, getFleetPool } from './fleetPersistence.js';

/**
 * Step 10 phase D (2026-08-14) — the server's record of a client report.
 *
 * WHY THIS EXISTS AT ALL. Sending moved to the server (spec §6a) because the Resend key must never
 * reach a user's machine. That cost a structural guarantee — the server previously had no means to
 * send mail as anyone — and the three bounds that replace it are enforced here and in the
 * controller, not by memory:
 *
 *   1. The server never originates a send. There is no scheduler and no requeue in this module; a
 *      row is only ever written by an authenticated device request.
 *   2. `report_id` is the PRIMARY KEY, so "the same id never sends twice" is a property of the
 *      database. `claimReportForSend` is the only way in and it fails closed on a duplicate.
 *   3. The record is written BEFORE the send is attempted, so a crash mid-send is visible.
 *
 * The recipient's address is the one field here belonging to somebody who never installed Ari
 * (§12.0), which is why `deleteSentReport` is a real delete and not a flag.
 */

export interface SentReportRecord {
  reportId: string;
  accountId: string;
  deviceId: string;
  machineId: string;
  projectName: string;
  rangeStartLocal: string;
  rangeEndLocal: string;
  recipientEmail: string;
  recipientName: string;
  /** Resolved server-side from the account profile; never accepted from the payload. */
  fromName: string;
  replyTo: string;
  totalHours: number;
  daysWorked: number;
  tasksCompleted: number;
  tasksTotal: number;
  linesJson: string;
  dailyJson: string;
  requestedAtUtc: string;
  /** The server's own timestamp, and the one that answers a dispute. Empty until Resend accepts. */
  sentAtUtc: string;
  /** pending | sent | failed */
  sendState: string;
  sendError: string;
}

const memoryStore = new Map<string, SentReportRecord>();

async function pool() {
  if (getFleetPersistenceMode() === 'memory') {
    return null;
  }
  await ensureFleetPersistenceReady();
  return getFleetPool();
}

/**
 * Reserve this report id for sending, writing the record as `pending`.
 *
 * Returns `false` when the id already exists — which is the idempotency bound. A retried request
 * after a send that actually succeeded must NOT put a second copy in a client's inbox, and there is
 * no recalling one. Fails closed: if we cannot tell, we do not send.
 */
export async function claimReportForSend(record: SentReportRecord): Promise<boolean> {
  const db = await pool();
  if (!db) {
    if (memoryStore.has(record.reportId)) {
      return false;
    }
    memoryStore.set(record.reportId, { ...record, sendState: 'pending', sentAtUtc: '', sendError: '' });
    return true;
  }

  // ON CONFLICT DO NOTHING + rowCount is the claim: two concurrent requests cannot both win.
  const result = await db.query(
    `
      INSERT INTO sent_reports (
        report_id, account_id, device_id, machine_id, project_name,
        range_start_local, range_end_local, recipient_email, recipient_name,
        from_name, reply_to, total_hours, days_worked, tasks_completed, tasks_total,
        lines_json, daily_json, requested_at_utc, sent_at_utc, send_state, send_error
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16::jsonb, $17::jsonb, $18::timestamptz, NULL, 'pending', ''
      )
      ON CONFLICT (report_id) DO NOTHING;
    `,
    [
      record.reportId, record.accountId, record.deviceId, record.machineId, record.projectName,
      record.rangeStartLocal, record.rangeEndLocal, record.recipientEmail, record.recipientName,
      record.fromName, record.replyTo, record.totalHours, record.daysWorked,
      record.tasksCompleted, record.tasksTotal,
      record.linesJson, record.dailyJson, record.requestedAtUtc
    ]
  );

  return (result.rowCount ?? 0) > 0;
}

export async function markReportOutcome(
  reportId: string,
  sent: boolean,
  sentAtUtc: string,
  error: string
): Promise<void> {
  const db = await pool();
  if (!db) {
    const existing = memoryStore.get(reportId);
    if (existing) {
      memoryStore.set(reportId, {
        ...existing,
        sendState: sent ? 'sent' : 'failed',
        sentAtUtc: sent ? sentAtUtc : '',
        sendError: error
      });
    }
    return;
  }

  await db.query(
    `
      UPDATE sent_reports
      SET send_state = $2, sent_at_utc = $3::timestamptz, send_error = $4
      WHERE report_id = $1;
    `,
    [reportId, sent ? 'sent' : 'failed', sent ? sentAtUtc : null, error]
  );
}

export async function getSentReport(reportId: string): Promise<SentReportRecord | null> {
  const db = await pool();
  if (!db) {
    return memoryStore.get(reportId) ?? null;
  }

  const result = await db.query('SELECT * FROM sent_reports WHERE report_id = $1;', [reportId]);
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    reportId: row.report_id,
    accountId: row.account_id,
    deviceId: row.device_id,
    machineId: row.machine_id,
    projectName: row.project_name,
    rangeStartLocal: row.range_start_local,
    rangeEndLocal: row.range_end_local,
    recipientEmail: row.recipient_email,
    recipientName: row.recipient_name,
    fromName: row.from_name,
    replyTo: row.reply_to,
    totalHours: Number(row.total_hours ?? 0),
    daysWorked: Number(row.days_worked ?? 0),
    tasksCompleted: Number(row.tasks_completed ?? 0),
    tasksTotal: Number(row.tasks_total ?? 0),
    linesJson: JSON.stringify(row.lines_json ?? []),
    dailyJson: JSON.stringify(row.daily_json ?? []),
    requestedAtUtc: row.requested_at_utc ? new Date(row.requested_at_utc).toISOString() : '',
    sentAtUtc: row.sent_at_utc ? new Date(row.sent_at_utc).toISOString() : '',
    sendState: row.send_state ?? 'pending',
    sendError: row.send_error ?? ''
  };
}

/**
 * A REAL delete, scoped to the owning account.
 *
 * Not a `deleted = 1` flag: the row holds the client's name, the labels and a third party's email
 * address, and a flagged row still holds all of it. §12.6.5.
 *
 * Returns true when the row is gone — including when it was already gone, because "delete something
 * that isn't there" has succeeded by any honest reading, and a false here would leave the agent
 * reporting a half-delete forever.
 */
export async function deleteSentReport(reportId: string, accountId: string): Promise<boolean> {
  const db = await pool();
  if (!db) {
    const existing = memoryStore.get(reportId);
    if (existing && existing.accountId !== accountId) {
      return false;
    }
    memoryStore.delete(reportId);
    return true;
  }

  const existing = await db.query('SELECT account_id FROM sent_reports WHERE report_id = $1;', [reportId]);
  if ((existing.rowCount ?? 0) > 0 && existing.rows[0].account_id !== accountId) {
    // Someone else's report. Refuse rather than delete, and do not say it worked.
    return false;
  }

  await db.query('DELETE FROM sent_reports WHERE report_id = $1;', [reportId]);
  return true;
}

/** Test seam only — the memory-mode store is process-local and must not leak between tests. */
export function __resetSentReportMemoryStore(): void {
  memoryStore.clear();
}
