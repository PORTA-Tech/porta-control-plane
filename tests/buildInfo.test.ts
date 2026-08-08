import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as supertest from 'supertest';
import { getBuildInfo, resetBuildInfoCache } from '../src/core/buildInfo.js';
import { createApp } from '../src/app.js';

// Same ESM-interop shim the rest of the suite uses (see endpointIntegration.test.ts).
const request = (supertest as unknown as { default: typeof supertest }).default as unknown as typeof import('supertest');

// /health used to return { ok: true } and nothing else, so the deployed commit could only be read
// from the Render dashboard. These pin the contract that answers it from outside.
describe('build info on /health', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    resetBuildInfoCache();
  });

  afterEach(() => {
    process.env = { ...saved };
    resetBuildInfoCache();
  });

  it('reports the commit Render built from', () => {
    process.env.RENDER_GIT_COMMIT = 'a52d5cc9f1e2b3d4c5a6978877665544332211ff';
    process.env.RENDER_GIT_BRANCH = 'main';

    const info = getBuildInfo();

    expect(info.commit).toBe('a52d5cc9f1e2b3d4c5a6978877665544332211ff');
    expect(info.commitShort).toBe('a52d5cc');
    expect(info.branch).toBe('main');
  });

  it('says unknown rather than guessing when no commit is in the environment', () => {
    delete process.env.RENDER_GIT_COMMIT;
    delete process.env.GIT_COMMIT;
    delete process.env.SOURCE_VERSION;

    const info = getBuildInfo();

    // A confidently wrong commit is worse than no commit: the whole point is to be able to trust it.
    expect(info.commit).toBe('unknown');
    expect(info.commitShort).toBe('unknown');
  });

  it('prefers an explicit APP_VERSION over package.json', () => {
    process.env.APP_VERSION = '2.4.9';

    expect(getBuildInfo().version).toBe('2.4.9');
  });

  it('finds a real version from package.json when APP_VERSION is unset', () => {
    delete process.env.APP_VERSION;

    // Walks up from the module rather than guessing a relative depth, so this holds whether the
    // code runs from src/ under tsx or from dist/ in production.
    expect(getBuildInfo().version).not.toBe('unknown');
  });

  it('keeps a stable start time across calls', () => {
    const first = getBuildInfo().startedAtUtc;
    resetBuildInfoCache();

    expect(getBuildInfo().startedAtUtc).toBe(first);
  });

  it('serves it on /health without breaking the ok flag the agent probes', async () => {
    process.env.RENDER_GIT_COMMIT = 'deadbeef00112233445566778899aabbccddeeff';

    const response = await request(createApp()).get('/health');

    expect(response.status).toBe(200);
    // The agent's uptime probe reads only this; adding fields must never disturb it.
    expect(response.body.ok).toBe(true);
    expect(response.body.commit).toBe('deadbeef00112233445566778899aabbccddeeff');
    expect(response.body.commit_short).toBe('deadbee');
    expect(typeof response.body.version).toBe('string');
    expect(typeof response.body.started_at_utc).toBe('string');
  });
});
