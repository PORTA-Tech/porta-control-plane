import type { MachineSummaryReport } from '@porta/api-contracts';
import { ensureFleetPersistenceReady, getFleetPersistenceMode, getFleetPool } from './fleetPersistence.js';

const machineSummaryMemoryStore = new Map<string, MachineSummaryReport>();

function normalizeAttentionSegmentKind(value: unknown): MachineSummaryReport['attentionSegmentKind'] {
  if (typeof value !== 'string') {
    return 'focus';
  }

  switch (value.trim().toLowerCase()) {
    case 'context_excursion':
      return 'context_excursion';
    case 'off_task_distraction':
      return 'off_task_distraction';
    case 'fragmentation_distraction':
      return 'fragmentation_distraction';
    case 'away':
      return 'away';
    default:
      return 'focus';
  }
}

function normalizeBreakKind(value: unknown): MachineSummaryReport['breakPendingKind'] {
  if (typeof value !== 'string') {
    return null;
  }

  switch (value.trim().toLowerCase()) {
    case 'short_break':
    case 'stretch_break_suggestion':
      return 'short_break';
    case 'long_break':
    case 'break_suggestion':
      return 'long_break';
    default:
      return null;
  }
}

function normalizeOptionalReasonCode(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.replace(/-/g, '_').toLowerCase() : null;
}

function normalizeOptionalReasonText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatEpisodeDuration(seconds: number): string {
  const totalSeconds = Math.max(0, Math.round(seconds));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return secs > 0 && minutes < 3 ? `${minutes}m ${secs}s` : `${minutes}m`;
}

function deriveAttentionSegmentReasonCode(
  report: MachineSummaryReport,
  attentionSegmentKind: MachineSummaryReport['attentionSegmentKind']
): string {
  const explicit = normalizeOptionalReasonCode(report.attentionSegmentReasonCode);
  if (explicit) {
    return explicit;
  }

  switch (attentionSegmentKind) {
    case 'away':
      return 'away';
    case 'context_excursion':
      return 'context_excursion';
    case 'off_task_distraction':
      return 'outside_focus_context';
    case 'fragmentation_distraction':
      return 'fragmentation_distraction';
    default:
      return 'steady_focus';
  }
}

function deriveAttentionSegmentReasonText(
  report: MachineSummaryReport,
  attentionSegmentKind: MachineSummaryReport['attentionSegmentKind'],
  attentionSegmentSeconds: number
): string {
  const explicit = normalizeOptionalReasonText(report.attentionSegmentReasonText);
  if (explicit) {
    return explicit;
  }

  switch (attentionSegmentKind) {
    case 'away':
      return `Away for ${formatEpisodeDuration(attentionSegmentSeconds)}.`;
    case 'context_excursion':
      return `Outside focus context for ${formatEpisodeDuration(attentionSegmentSeconds)}.`;
    case 'off_task_distraction':
      return `Stayed outside focus context for ${formatEpisodeDuration(report.distractionEpisodeSeconds ?? attentionSegmentSeconds)}.`;
    case 'fragmentation_distraction':
      return `Rapid switching / fragmentation for ${formatEpisodeDuration(report.distractionEpisodeSeconds ?? attentionSegmentSeconds)}.`;
    default:
      return 'Steady focus episode.';
  }
}

function deriveFocusEpisodeReasonCode(
  report: MachineSummaryReport,
  focusEpisodeState: MachineSummaryReport['focusEpisodeState'],
  attentionSegmentKind: MachineSummaryReport['attentionSegmentKind']
): string {
  const explicit = normalizeOptionalReasonCode(report.focusEpisodeReasonCode);
  if (explicit) {
    return explicit;
  }

  if (focusEpisodeState === 'reset') {
    switch (attentionSegmentKind) {
      case 'away':
        return 'long_break';
      case 'off_task_distraction':
      case 'context_excursion':
        return 'major_context_shift';
      case 'fragmentation_distraction':
        return 'instability_reset';
      default:
        return 'focus_episode_reset';
    }
  }

  if (focusEpisodeState === 'pause') {
    return 'focus_episode_paused';
  }

  if (focusEpisodeState === 'decay') {
    return 'focus_episode_decay';
  }

  return 'focus_episode_active';
}

function deriveFocusEpisodeReasonText(
  report: MachineSummaryReport,
  focusEpisodeState: MachineSummaryReport['focusEpisodeState'],
  attentionSegmentKind: MachineSummaryReport['attentionSegmentKind'],
  attentionSegmentSeconds: number
): string {
  const explicit = normalizeOptionalReasonText(report.focusEpisodeReasonText);
  if (explicit) {
    return explicit;
  }

  if (focusEpisodeState === 'reset') {
    switch (attentionSegmentKind) {
      case 'away':
        return `Long break ended the focus episode after ${formatEpisodeDuration(attentionSegmentSeconds)} away.`;
      case 'off_task_distraction':
      case 'context_excursion':
        return 'Major context shift ended the focus episode.';
      case 'fragmentation_distraction':
        return 'Sustained instability ended the focus episode.';
      default:
        return 'Focus episode ended.';
    }
  }

  if (focusEpisodeState === 'pause') {
    return 'Focus episode is paused.';
  }

  if (focusEpisodeState === 'decay') {
    return 'Focus episode is fading.';
  }

  return 'Focus episode active.';
}

export function withCanonicalMachineSummary(report: MachineSummaryReport): MachineSummaryReport {
  const focusEpisodeQuality = Number.isFinite(report.focusEpisodeQuality)
    ? report.focusEpisodeQuality
    : report.taskContinuityScore;
  const focusEpisodeSeconds = Number.isFinite(report.focusEpisodeSeconds)
    ? report.focusEpisodeSeconds
    : report.taskContinuitySeconds;
  const focusEpisodeState = (typeof report.focusEpisodeState === 'string' && report.focusEpisodeState.trim().length > 0)
    ? report.focusEpisodeState
    : report.continuityState;
  const attentionSegmentKind = normalizeAttentionSegmentKind(report.attentionSegmentKind);
  const attentionSegmentSeconds = Number.isFinite(report.attentionSegmentSeconds)
    ? report.attentionSegmentSeconds
    : 0;
  const distractionEpisodeActive = typeof report.distractionEpisodeActive === 'boolean'
    ? report.distractionEpisodeActive
    : (attentionSegmentKind === 'off_task_distraction' || attentionSegmentKind === 'fragmentation_distraction');
  const distractionEpisodeSeconds = Number.isFinite(report.distractionEpisodeSeconds)
    ? report.distractionEpisodeSeconds
    : (distractionEpisodeActive ? attentionSegmentSeconds : 0);
  const pressureLevel = Number.isFinite(report.pressureLevel)
    ? report.pressureLevel
    : report.overloadLikelihood;
  const pressureConfidence = Number.isFinite(report.pressureConfidence)
    ? report.pressureConfidence
    : report.modelConfidence;
  const breakPendingKind = normalizeBreakKind(report.breakPendingKind ?? report.breakPendingAction);
  const attentionSegmentReasonCode = deriveAttentionSegmentReasonCode(report, attentionSegmentKind);
  const attentionSegmentReasonText = deriveAttentionSegmentReasonText(report, attentionSegmentKind, attentionSegmentSeconds);
  const focusEpisodeReasonCode = deriveFocusEpisodeReasonCode(report, focusEpisodeState, attentionSegmentKind);
  const focusEpisodeReasonText = deriveFocusEpisodeReasonText(report, focusEpisodeState, attentionSegmentKind, attentionSegmentSeconds);

  return {
    ...report,
    focusEpisodeQuality,
    focusEpisodeSeconds,
    focusEpisodeState,
    focusEpisodeReasonCode,
    focusEpisodeReasonText,
    attentionSegmentKind,
    attentionSegmentSeconds,
    attentionSegmentReasonCode,
    attentionSegmentReasonText,
    distractionEpisodeActive,
    distractionEpisodeSeconds,
    pressureLevel,
    pressureConfidence,
    breakPendingKind: breakPendingKind ?? null,
    taskContinuityScore: Number.isFinite(report.taskContinuityScore) ? report.taskContinuityScore : focusEpisodeQuality,
    taskContinuitySeconds: Number.isFinite(report.taskContinuitySeconds) ? report.taskContinuitySeconds : focusEpisodeSeconds,
    continuityState: (typeof report.continuityState === 'string' && report.continuityState.trim().length > 0)
      ? report.continuityState
      : focusEpisodeState
  };
}

export async function upsertMachineSummary(report: MachineSummaryReport): Promise<void> {
  // Stored payload_json preserves the canonical focus-episode fields and keeps
  // the legacy continuity aliases alongside them for migration safety.
  const normalized = withCanonicalMachineSummary(report);
  if (getFleetPersistenceMode() === 'memory') {
    machineSummaryMemoryStore.set(normalized.machineId, normalized);
    return;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    machineSummaryMemoryStore.set(normalized.machineId, normalized);
    return;
  }

  await pool.query(
    `
      INSERT INTO machine_summaries (
        machine_id,
        machine_name,
        user_name,
        reported_at_utc,
        trust_tier,
        calibration_stage,
        capture_context,
        last_activity_utc,
        payload_json,
        updated_at_utc
      ) VALUES (
        $1, $2, $3, $4::timestamptz, $5, $6, $7, $8::timestamptz, $9::jsonb, NOW()
      )
      ON CONFLICT (machine_id) DO UPDATE SET
        machine_name = EXCLUDED.machine_name,
        user_name = EXCLUDED.user_name,
        reported_at_utc = EXCLUDED.reported_at_utc,
        trust_tier = EXCLUDED.trust_tier,
        calibration_stage = EXCLUDED.calibration_stage,
        capture_context = EXCLUDED.capture_context,
        last_activity_utc = EXCLUDED.last_activity_utc,
        payload_json = EXCLUDED.payload_json,
        updated_at_utc = NOW();
    `,
    [
      normalized.machineId,
      normalized.machineName,
      normalized.userName,
      normalized.reportedAtUtc,
      normalized.trustTier,
      normalized.calibrationStage,
      normalized.captureContext,
      normalized.lastActivityUtc ?? null,
      JSON.stringify(normalized)
    ]
  );
}

export async function getMachineSummary(machineId: string): Promise<MachineSummaryReport | null> {
  if (getFleetPersistenceMode() === 'memory') {
    return machineSummaryMemoryStore.get(machineId) ?? null;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return machineSummaryMemoryStore.get(machineId) ?? null;
  }

  const result = await pool.query<{ payload_json: MachineSummaryReport }>(
    `
      SELECT payload_json
      FROM machine_summaries
      WHERE machine_id = $1
      LIMIT 1;
    `,
    [machineId]
  );

  const row = result.rows[0]?.payload_json ?? null;
  return row ? withCanonicalMachineSummary(row) : null;
}

export async function listMachineSummaries(): Promise<MachineSummaryReport[]> {
  if (getFleetPersistenceMode() === 'memory') {
    return Array.from(machineSummaryMemoryStore.values()).map(withCanonicalMachineSummary).sort(
      (a, b) => Date.parse(b.reportedAtUtc) - Date.parse(a.reportedAtUtc)
    );
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return Array.from(machineSummaryMemoryStore.values()).map(withCanonicalMachineSummary).sort(
      (a, b) => Date.parse(b.reportedAtUtc) - Date.parse(a.reportedAtUtc)
    );
  }

  const result = await pool.query<{ payload_json: MachineSummaryReport }>(
    `
      SELECT payload_json
      FROM machine_summaries
      ORDER BY reported_at_utc DESC, machine_id ASC;
    `
  );

  return result.rows.map((row: { payload_json: MachineSummaryReport }) => withCanonicalMachineSummary(row.payload_json));
}

export function clearMachineSummaryStoreForTests(): void {
  machineSummaryMemoryStore.clear();
}
