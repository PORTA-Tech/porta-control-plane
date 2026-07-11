import { ensureFleetPersistenceReady, getFleetPersistenceMode, getFleetPool } from './fleetPersistence.js';

/**
 * 2d — coarse app-category labels the fleet resolves for tokens the Windows agent could not
 * classify locally.
 *
 * A `token` is a COARSE identity produced by the agent: a browser site token ("notion",
 * "linear") or an exe base name ("obsidian", "figma"). It is NEVER a raw URL or window title,
 * so nothing page-identifying is ever persisted here. A `category` is one of the 8 AppCategory
 * names below (or 'Unknown' while a token is still pending resolution).
 *
 * `source` records how a mapping was produced and defines read-time precedence:
 *   override (operator correction) > curated (server seed) > llm (Haiku) > pending (queued, unresolved).
 * Reads only ever return resolved rows (source != 'pending').
 */

/** The 8 AppCategory names, kept in lockstep with Porta.Agent.Common.Analysis.AppCategory (C#). */
export const APP_CATEGORY_NAMES = [
  'Unknown',
  'Entertainment',
  'Communication',
  'SocialMedia',
  'Gaming',
  'Development',
  'Productivity',
  'GamingLauncher'
] as const;

export type AppCategoryName = (typeof APP_CATEGORY_NAMES)[number];
export type AppCategorySource = 'override' | 'curated' | 'llm' | 'pending';

export interface AppCategoryLabel {
  token: string;
  category: AppCategoryName;
  source: AppCategorySource;
  modelVer: string | null;
  createdAt: string;
  updatedAt: string;
}

const appCategoryMemoryStore = new Map<string, AppCategoryLabel>();

/** True if the value is one of the 8 known category names. */
export function isAppCategoryName(value: unknown): value is AppCategoryName {
  return typeof value === 'string' && (APP_CATEGORY_NAMES as readonly string[]).includes(value);
}

/**
 * Coarse-token guard: lowercase, keep only [a-z0-9-], reject anything else. Mirrors the agent's
 * NormalizeDomainToken so a malformed or page-identifying value can never enter the table.
 */
export function normalizeToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  if (!/^[a-z0-9-]+$/.test(trimmed)) return null;
  return trimmed;
}

interface LabelRow {
  token: string;
  category: string;
  source: string;
  model_ver: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function rowToLabel(row: LabelRow): AppCategoryLabel {
  return {
    token: row.token,
    category: isAppCategoryName(row.category) ? row.category : 'Unknown',
    source: (['override', 'curated', 'llm', 'pending'] as string[]).includes(row.source)
      ? (row.source as AppCategorySource)
      : 'llm',
    modelVer: row.model_ver ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

/**
 * Returns resolved mappings (source != 'pending') for the requested tokens, as token -> category.
 * Tokens with no resolved row are simply absent from the result.
 */
export async function getKnown(tokens: string[]): Promise<Record<string, AppCategoryName>> {
  const normalized = Array.from(
    new Set(tokens.map(normalizeToken).filter((t): t is string => t !== null))
  );
  if (normalized.length === 0) return {};

  if (getFleetPersistenceMode() === 'memory') {
    return knownFromMemory(normalized);
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) return knownFromMemory(normalized);

  const result = await pool.query<LabelRow>(
    `
      SELECT token, category, source, model_ver, created_at, updated_at
      FROM app_category_labels
      WHERE token = ANY($1::text[]) AND source <> 'pending';
    `,
    [normalized]
  );

  const out: Record<string, AppCategoryName> = {};
  for (const row of result.rows) {
    const label = rowToLabel(row);
    out[label.token] = label.category;
  }
  return out;
}

function knownFromMemory(tokens: string[]): Record<string, AppCategoryName> {
  const out: Record<string, AppCategoryName> = {};
  for (const token of tokens) {
    const label = appCategoryMemoryStore.get(token);
    if (label && label.source !== 'pending') {
      out[token] = label.category;
    }
  }
  return out;
}

/**
 * Records never-before-seen tokens as pending so the worker can classify them later. Tokens that
 * already have any row (pending or resolved) are left untouched. Returns the tokens newly queued.
 */
export async function queueUnknown(tokens: string[]): Promise<string[]> {
  const normalized = Array.from(
    new Set(tokens.map(normalizeToken).filter((t): t is string => t !== null))
  );
  if (normalized.length === 0) return [];

  const nowIso = new Date().toISOString();

  if (getFleetPersistenceMode() === 'memory') {
    return queueUnknownInMemory(normalized, nowIso);
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) return queueUnknownInMemory(normalized, nowIso);

  const result = await pool.query<{ token: string }>(
    `
      INSERT INTO app_category_labels (token, category, source, model_ver, created_at, updated_at)
      SELECT t, 'Unknown', 'pending', NULL, $2::timestamptz, $2::timestamptz
      FROM unnest($1::text[]) AS t
      ON CONFLICT (token) DO NOTHING
      RETURNING token;
    `,
    [normalized, nowIso]
  );

  return result.rows.map((r) => r.token);
}

function queueUnknownInMemory(tokens: string[], nowIso: string): string[] {
  const queued: string[] = [];
  for (const token of tokens) {
    if (!appCategoryMemoryStore.has(token)) {
      appCategoryMemoryStore.set(token, {
        token,
        category: 'Unknown',
        source: 'pending',
        modelVer: null,
        createdAt: nowIso,
        updatedAt: nowIso
      });
      queued.push(token);
    }
  }
  return queued;
}

/** Returns up to `limit` tokens still awaiting classification (source = 'pending'). */
export async function listPending(limit = 50): Promise<string[]> {
  const capped = Math.max(1, Math.min(limit, 200));

  if (getFleetPersistenceMode() === 'memory') {
    return listPendingFromMemory(capped);
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) return listPendingFromMemory(capped);

  const result = await pool.query<{ token: string }>(
    `
      SELECT token
      FROM app_category_labels
      WHERE source = 'pending'
      ORDER BY created_at ASC
      LIMIT $1;
    `,
    [capped]
  );

  return result.rows.map((r) => r.token);
}

function listPendingFromMemory(limit: number): string[] {
  return Array.from(appCategoryMemoryStore.values())
    .filter((label) => label.source === 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, limit)
    .map((label) => label.token);
}

export interface ResolvedLabel {
  token: string;
  category: AppCategoryName;
  source: AppCategorySource;
  modelVer?: string | null;
}

/**
 * Upserts resolved mappings. Never downgrades an operator override: a row already at
 * source='override' is left unchanged unless the incoming row is itself an override.
 */
export async function upsertResolved(labels: ResolvedLabel[]): Promise<void> {
  const clean = labels
    .map((l) => ({ ...l, token: normalizeToken(l.token) }))
    .filter((l): l is ResolvedLabel & { token: string } => l.token !== null && isAppCategoryName(l.category));
  if (clean.length === 0) return;

  const nowIso = new Date().toISOString();

  if (getFleetPersistenceMode() === 'memory') {
    upsertResolvedInMemory(clean, nowIso);
    return;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    upsertResolvedInMemory(clean, nowIso);
    return;
  }

  for (const label of clean) {
    await pool.query(
      `
        INSERT INTO app_category_labels (token, category, source, model_ver, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz)
        ON CONFLICT (token) DO UPDATE SET
          category  = EXCLUDED.category,
          source    = EXCLUDED.source,
          model_ver = EXCLUDED.model_ver,
          updated_at = EXCLUDED.updated_at
        WHERE app_category_labels.source <> 'override' OR EXCLUDED.source = 'override';
      `,
      [label.token, label.category, label.source, label.modelVer ?? null, nowIso]
    );
  }
}

function upsertResolvedInMemory(labels: Array<ResolvedLabel & { token: string }>, nowIso: string): void {
  for (const label of labels) {
    const existing = appCategoryMemoryStore.get(label.token);
    if (existing && existing.source === 'override' && label.source !== 'override') {
      continue;
    }
    appCategoryMemoryStore.set(label.token, {
      token: label.token,
      category: label.category,
      source: label.source,
      modelVer: label.modelVer ?? null,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso
    });
  }
}

/** Operator manual correction — always wins (source='override'). */
export async function setOverride(token: string, category: AppCategoryName): Promise<void> {
  const normalized = normalizeToken(token);
  if (!normalized || !isAppCategoryName(category)) return;
  await upsertResolved([{ token: normalized, category, source: 'override', modelVer: null }]);
}

/** Full listing for the operator console, newest-updated first. */
export async function listAll(): Promise<AppCategoryLabel[]> {
  if (getFleetPersistenceMode() === 'memory') {
    return Array.from(appCategoryMemoryStore.values()).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return Array.from(appCategoryMemoryStore.values()).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
  }

  const result = await pool.query<LabelRow>(
    `
      SELECT token, category, source, model_ver, created_at, updated_at
      FROM app_category_labels
      ORDER BY updated_at DESC;
    `
  );

  return result.rows.map(rowToLabel);
}

/** Test-only: clear the in-memory store between cases. */
export function resetAppCategoryLabelsForTests(): void {
  appCategoryMemoryStore.clear();
}
