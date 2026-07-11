import * as supertest from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  getKnown,
  queueUnknown,
  listPending,
  upsertResolved,
  setOverride,
  listAll,
  normalizeToken,
  isAppCategoryName,
  resetAppCategoryLabelsForTests
} from '../src/store/appCategoryLabelStore.js';

const request = (supertest as unknown as { default: typeof supertest }).default as unknown as typeof import('supertest');
const app = createApp();

describe('appCategoryLabelStore', () => {
  beforeEach(() => {
    resetAppCategoryLabelsForTests();
  });

  it('normalizeToken enforces the coarse-token privacy guard', () => {
    expect(normalizeToken('  NoTion ')).toBe('notion');
    expect(normalizeToken('mail.google.com')).toBeNull(); // dots (a domain) rejected
    expect(normalizeToken('github/owner')).toBeNull(); // path rejected
    expect(normalizeToken('a'.repeat(65))).toBeNull(); // over length
    expect(normalizeToken('   ')).toBeNull();
  });

  it('isAppCategoryName only accepts the 8 names', () => {
    expect(isAppCategoryName('Development')).toBe(true);
    expect(isAppCategoryName('Productivity')).toBe(true);
    expect(isAppCategoryName('Nope')).toBe(false);
  });

  it('queues unknowns (deduped, invalid dropped) and never returns them as known', async () => {
    const queued = await queueUnknown(['notion', 'linear', 'notion', 'BAD.DOMAIN']);
    expect(queued.sort()).toEqual(['linear', 'notion']);

    expect(await getKnown(['notion', 'linear'])).toEqual({});
    expect((await listPending(50)).sort()).toEqual(['linear', 'notion']);

    // re-queueing an existing token is a no-op
    expect(await queueUnknown(['notion'])).toEqual([]);
  });

  it('resolves a pending token and drops it from the pending set', async () => {
    await queueUnknown(['notion', 'linear']);
    await upsertResolved([{ token: 'notion', category: 'Productivity', source: 'llm', modelVer: 'haiku-x' }]);

    expect(await getKnown(['notion', 'linear'])).toEqual({ notion: 'Productivity' });
    expect(await listPending(50)).toEqual(['linear']);
  });

  it('operator override wins over a later llm result', async () => {
    await setOverride('notion', 'Development');
    await upsertResolved([{ token: 'notion', category: 'Entertainment', source: 'llm' }]);
    expect(await getKnown(['notion'])).toEqual({ notion: 'Development' });
  });

  it('rejects an invalid category in upsertResolved', async () => {
    // @ts-expect-error deliberately invalid category
    await upsertResolved([{ token: 'figma', category: 'Bogus', source: 'llm' }]);
    expect(await getKnown(['figma'])).toEqual({});
  });

  it('listAll returns well-formed rows', async () => {
    await upsertResolved([{ token: 'slack', category: 'Communication', source: 'curated' }]);
    const all = await listAll();
    expect(all.every((r) => r.token && r.category && r.source)).toBe(true);
    expect(all.find((r) => r.token === 'slack')?.category).toBe('Communication');
  });
});

describe('POST /api/agent/categories/resolve', () => {
  beforeEach(() => {
    resetAppCategoryLabelsForTests();
  });

  it('requires an agentId', async () => {
    const res = await request(app).post('/api/agent/categories/resolve').send({ tokens: ['notion'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('agentId');
  });

  it('returns known mappings immediately and queues unknowns as pending', async () => {
    await upsertResolved([{ token: 'slack', category: 'Communication', source: 'llm' }]);

    const res = await request(app)
      .post('/api/agent/categories/resolve')
      .send({ agentId: 'dev-1', tokens: ['slack', 'obsidian', 'linear'] });

    expect(res.status).toBe(200);
    expect(res.body.mappings).toEqual({ slack: 'Communication' });
    expect(res.body.pending.sort()).toEqual(['linear', 'obsidian']);

    // the previously-unknown tokens are now queued for the worker
    expect((await listPending(50)).sort()).toEqual(['linear', 'obsidian']);
  });

  it('does not re-queue already-pending tokens on repeat calls', async () => {
    await request(app).post('/api/agent/categories/resolve').send({ agentId: 'dev-1', tokens: ['obsidian'] });
    const res = await request(app).post('/api/agent/categories/resolve').send({ agentId: 'dev-1', tokens: ['obsidian'] });
    expect(res.body.pending).toEqual([]); // already queued -> nothing newly pending
    expect(await listPending(50)).toEqual(['obsidian']);
  });
});
