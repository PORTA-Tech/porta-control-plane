import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Step 10 phase C/D (2026-08-14) — nothing about ONE user may be baked into the control plane.
 *
 * The counterpart of `NoPersonalIdentifiersShipTests` in the agent repo, and it matters more here:
 * this is the side that actually composes and sends the mail, so this is where a hardcoded `from`
 * or `replyTo` would silently make the product work for exactly one person. The founder is the only
 * real user today, which is precisely the condition under which that happens and is never noticed,
 * because on his account it looks correct.
 *
 * Two rules, same split as the agent's, and for the same reasons:
 *
 *   NAMES are checked against comment-stripped source. Attribution in a comment is history and
 *   cannot reach a screen or the wire.
 *
 *   ADDRESSES are checked against the raw file, comments included — an address in a comment is an
 *   address someone pastes into code later (Yadin, 2026-08-14).
 */

const SRC = join(process.cwd(), 'src');

/** Service addresses that MUST be hardcoded: they belong to the product, not to a person. */
const ALLOWED_ADDRESSES = ['ari@useporta.com', 'reports@useporta.com', 'support@useporta.com'];

/**
 * Domains at which an address cannot belong to anyone. `.test`, `.example`, `.invalid` and
 * `.localhost` are reserved by RFC 2606 and can never be registered or delivered to;
 * `porta.internal` is the synthetic collision domain and is non-deliverable by design.
 */
const UNDELIVERABLE = ['.test', '.example', '.invalid', '.localhost', 'porta.internal'];

const PERSONAL_IDENTIFIERS = ['insideporta2', 'Yadin Sela'];

const CONSUMER_DOMAINS = [
  '@gmail.com', '@googlemail.com', '@outlook.com', '@hotmail.com',
  '@yahoo.com', '@icloud.com', '@proton.me', '@protonmail.com'
];

const EMAIL_SHAPED = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[^\r\n'"`]*\/\/[^\r\n]*/gm, ' ');
}

function shippedSources(): Array<{ path: string; raw: string; code: string }> {
  const out: Array<{ path: string; raw: string; code: string }> = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== 'node_modules' && entry !== 'dist') {
          walk(full);
        }
        continue;
      }

      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) {
        continue;
      }

      const raw = readFileSync(full, 'utf8');
      out.push({ path: relative(process.cwd(), full), raw, code: stripComments(raw) });
    }
  };

  walk(SRC);
  return out;
}

describe('no personal identifiers ship in the control plane', () => {
  it('scans the real source, so a pass is not an empty set', () => {
    const sources = shippedSources();

    expect(sources.length).toBeGreaterThan(30);
    // The three files where a sender default would actually be typed.
    expect(sources.some((s) => s.path.endsWith('emailService.ts'))).toBe(true);
    expect(sources.some((s) => s.path.endsWith('reportsController.ts'))).toBe(true);
    expect(sources.some((s) => s.path.endsWith('reportEmailBuilder.ts'))).toBe(true);
    // And the stripper is not eating whole files.
    expect(sources.some((s) => s.code.includes('export'))).toBe(true);
  });

  it('contains no personal identifier in shippable code', () => {
    const offenders: string[] = [];

    for (const { path, code } of shippedSources()) {
      for (const identifier of PERSONAL_IDENTIFIERS) {
        if (code.toLowerCase().includes(identifier.toLowerCase())) {
          offenders.push(`${path}: "${identifier}"`);
        }
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('names no consumer mail provider anywhere, comments included', () => {
    const offenders: string[] = [];

    for (const { path, raw } of shippedSources()) {
      for (const domain of CONSUMER_DOMAINS) {
        if (raw.toLowerCase().includes(domain)) {
          offenders.push(`${path}: "${domain}"`);
        }
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('hardcodes no email address that could belong to a person', () => {
    const offenders: string[] = [];

    for (const { path, raw } of shippedSources()) {
      for (const found of raw.match(EMAIL_SHAPED) ?? []) {
        const lower = found.toLowerCase();
        const allowed =
          ALLOWED_ADDRESSES.includes(lower) || UNDELIVERABLE.some((d) => lower.endsWith(d));

        if (!allowed) {
          offenders.push(`${path}: "${found}"`);
        }
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('does not let the undeliverable allowance excuse a real domain', () => {
    const deliverable = 'someone@example-company.com';

    expect(UNDELIVERABLE.some((d) => deliverable.endsWith(d))).toBe(false);
    expect(ALLOWED_ADDRESSES.includes(deliverable)).toBe(false);
  });
});
