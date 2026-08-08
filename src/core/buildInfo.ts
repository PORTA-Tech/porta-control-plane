import { readFileSync } from 'node:fs';
import { dirname, resolve, parse as parsePath } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What this instance actually is, so "what is Render running?" can be answered from the outside.
 *
 * Until now it could not be: /health returned { ok: true } and nothing else, so the only source of
 * truth for the deployed commit was the Render dashboard's deploy log. That matters more than it
 * sounds — a local checkout can sit identical to origin/main for days while the running service is
 * something else entirely, and there was no way to tell without leaving the terminal.
 *
 * The commit comes from Render's own build environment (RENDER_GIT_COMMIT), so nothing has to be
 * baked in at build time and there is no step anyone can forget.
 */
export interface BuildInfo {
  version: string;
  commit: string;
  commitShort: string;
  branch: string;
  startedAtUtc: string;
}

// Captured once, at module load, which is process start for a server.
const startedAtUtc = new Date().toISOString();

let cached: BuildInfo | null = null;

function firstNonEmpty(...values: (string | undefined)[]): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return 'unknown';
}

/**
 * Walks up from this module looking for package.json. Deterministic rather than a list of guessed
 * relative paths, so it works the same whether this runs from src/ under tsx or from dist/ in
 * production — the two layouts sit at different depths.
 */
function readPackageVersion(): string {
  const fromEnv = process.env.APP_VERSION?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  let dir = dirname(fileURLToPath(import.meta.url));
  const { root } = parsePath(dir);
  while (true) {
    try {
      const raw = readFileSync(resolve(dir, 'package.json'), 'utf8');
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.trim().length > 0) {
        return parsed.version.trim();
      }
    } catch {
      // Not here, or unreadable — keep walking.
    }

    const parent = dirname(dir);
    if (parent === dir || dir === root) {
      return 'unknown';
    }

    dir = parent;
  }
}

export function getBuildInfo(): BuildInfo {
  if (cached) {
    return cached;
  }

  // RENDER_GIT_COMMIT is set by Render for every deploy. The others are fallbacks for running
  // somewhere else (a container build, a local run) so this never reports a confidently wrong value.
  const commit = firstNonEmpty(
    process.env.RENDER_GIT_COMMIT,
    process.env.GIT_COMMIT,
    process.env.SOURCE_VERSION
  );

  cached = {
    version: readPackageVersion(),
    commit,
    commitShort: commit === 'unknown' ? 'unknown' : commit.slice(0, 7),
    branch: firstNonEmpty(process.env.RENDER_GIT_BRANCH, process.env.GIT_BRANCH),
    startedAtUtc
  };

  return cached;
}

/** Test seam: forget the memoized value so an env change can be observed. */
export function resetBuildInfoCache(): void {
  cached = null;
}
