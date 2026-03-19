import * as supertest from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const request = (supertest as unknown as { default: typeof supertest }).default as unknown as typeof import('supertest');
const app = createApp();

describe('client release endpoints', () => {
  beforeEach(() => {
    delete process.env.PORTA_WINDOWS_RELEASE_VERSION;
    delete process.env.PORTA_WINDOWS_LATEST_VERSION;
    delete process.env.PORTA_WINDOWS_RELEASE_MSI_URL;
    delete process.env.PORTA_WINDOWS_MSI_URL;
    delete process.env.PORTA_WINDOWS_RELEASE_CHANNEL;
    delete process.env.PORTA_WINDOWS_RELEASE_PUBLISHED_AT_UTC;
    delete process.env.PORTA_WINDOWS_RELEASE_MIN_SUPPORTED_VERSION;
    delete process.env.PORTA_WINDOWS_RELEASE_REQUIRED;
    delete process.env.PORTA_WINDOWS_RELEASE_TITLE;
    delete process.env.PORTA_WINDOWS_RELEASE_SUMMARY;
    delete process.env.PORTA_WINDOWS_RELEASE_SHA256;
  });

  it('returns 404 when no Windows release is configured', async () => {
    const response = await request(app).get('/api/client-release/windows/latest');
    expect(response.status).toBe(404);
    expect(response.body.error_code).toBe('WINDOWS_RELEASE_NOT_CONFIGURED');
  });

  it('returns the configured Windows release manifest', async () => {
    process.env.PORTA_WINDOWS_RELEASE_VERSION = '1.0.2';
    process.env.PORTA_WINDOWS_RELEASE_MSI_URL = 'https://downloads.porta.ai/windows/AriAgentInstaller-1.0.2.msi';
    process.env.PORTA_WINDOWS_RELEASE_PUBLISHED_AT_UTC = '2026-03-19T12:10:00.000Z';
    process.env.PORTA_WINDOWS_RELEASE_MIN_SUPPORTED_VERSION = '1.0.0';
    process.env.PORTA_WINDOWS_RELEASE_REQUIRED = 'true';
    process.env.PORTA_WINDOWS_RELEASE_TITLE = 'Ari 1.0.2 is ready';
    process.env.PORTA_WINDOWS_RELEASE_SUMMARY = 'Fixes onboarding and device auto-linking.';
    process.env.PORTA_WINDOWS_RELEASE_SHA256 = 'deadbeef';

    const response = await request(app).get('/api/client-release/windows/latest');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      platform: 'windows-x64',
      channel: 'stable',
      version: '1.0.2',
      msiUrl: 'https://downloads.porta.ai/windows/AriAgentInstaller-1.0.2.msi',
      publishedAtUtc: '2026-03-19T12:10:00.000Z',
      minimumSupportedVersion: '1.0.0',
      required: true,
      title: 'Ari 1.0.2 is ready',
      summary: 'Fixes onboarding and device auto-linking.',
      sha256: 'deadbeef'
    });
  });
});
