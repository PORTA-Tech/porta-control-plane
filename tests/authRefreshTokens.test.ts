import * as supertest from 'supertest';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  clearAuthSessionStoreForTests,
  issueAuthSession,
  readAuthSession,
  redeemRefreshToken,
  registerAuthUser,
  revokeAuthSession
} from '../src/core/authSessionStore.js';

const request = (supertest as unknown as { default: typeof supertest }).default as unknown as typeof import('supertest');
const app = createApp();

const password = 'Refresh-Token-Test-1';

/**
 * A registered user, not a fabricated session view. Redemption deliberately re-derives
 * the identity from the user store on every use, so a user that was never registered
 * cannot refresh — which is the behaviour under test in "account no longer resolves".
 */
async function registerUser(): Promise<string> {
  const userId = `refresh.${randomUUID().slice(0, 8)}@example.com`;
  const created = await registerAuthUser({
    user_id: userId,
    password,
    display_name: 'Refresh Tester',
    role: 'developer'
  });
  expect(created.ok).toBe(true);
  return userId;
}

async function signIn(userId: string, issueRefreshToken: boolean) {
  const response = await request(app)
    .post('/auth/login')
    .send({ user_id: userId, password, issue_refresh_token: issueRefreshToken });
  expect(response.status).toBe(200);
  return response.body as {
    access_token: string;
    refresh_token?: string;
    refresh_expires_at_utc?: string;
  };
}

describe('auth refresh tokens', () => {
  beforeEach(() => {
    clearAuthSessionStoreForTests();
  });

  it('does not mint a refresh token unless the client asks for one', async () => {
    const userId = await registerUser();

    const withoutFlag = await signIn(userId, false);
    expect(withoutFlag.access_token).toBeTruthy();
    expect(withoutFlag.refresh_token).toBeUndefined();

    const withFlag = await signIn(userId, true);
    expect(withFlag.refresh_token).toBeTruthy();
    expect(withFlag.refresh_expires_at_utc).toBeTruthy();
  });

  it('gives the refresh token a longer life than the access session', async () => {
    const userId = await registerUser();
    const signedIn = await signIn(userId, true);

    const session = await readAuthSession(signedIn.access_token);
    expect(session).not.toBeNull();
    expect(Date.parse(signedIn.refresh_expires_at_utc!))
      .toBeGreaterThan(Date.parse(session!.expires_at_utc));
  });

  it('refuses a refresh token presented as a bearer token', async () => {
    const userId = await registerUser();
    const signedIn = await signIn(userId, true);

    // The whole reason session_type exists. If readAuthSession accepted this, the
    // long-lived credential would authenticate every route in the API.
    expect(await readAuthSession(signedIn.refresh_token!)).toBeNull();

    const response = await request(app)
      .get('/auth/me')
      .set('authorization', `Bearer ${signedIn.refresh_token}`);
    expect(response.status).toBe(401);
  });

  it('exchanges a refresh token for a working access token and rotates it', async () => {
    const userId = await registerUser();
    const signedIn = await signIn(userId, true);

    const refreshed = await request(app)
      .post('/auth/refresh')
      .send({ refresh_token: signedIn.refresh_token });

    expect(refreshed.status).toBe(200);
    expect(refreshed.body.access_token).toBeTruthy();
    expect(refreshed.body.access_token).not.toBe(signedIn.access_token);
    expect(refreshed.body.refresh_token).toBeTruthy();
    expect(refreshed.body.refresh_token).not.toBe(signedIn.refresh_token);
    expect(refreshed.body.user.user_id).toBe(userId);

    const session = await readAuthSession(refreshed.body.access_token as string);
    expect(session?.user_id).toBe(userId);
  });

  it('revokes the whole chain when a rotated-away refresh token is presented again', async () => {
    const userId = await registerUser();
    const signedIn = await signIn(userId, true);

    const first = await redeemRefreshToken(signedIn.refresh_token!);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // The stolen copy. Redeeming it must not merely fail: the legitimate client's
    // tokens have to die too, because we cannot tell which of the two is the thief.
    const reused = await request(app)
      .post('/auth/refresh')
      .send({ refresh_token: signedIn.refresh_token });

    expect(reused.status).toBe(401);
    expect(reused.body.error_code).toBe('REFRESH_TOKEN_REUSED');

    expect(await readAuthSession(first.access_token)).toBeNull();
    const secondAttempt = await redeemRefreshToken(first.refresh_token);
    expect(secondAttempt.ok).toBe(false);
  });

  it('rejects a token that was never issued', async () => {
    const attempt = await redeemRefreshToken('not-a-real-refresh-token');
    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(attempt.error_code).toBe('REFRESH_TOKEN_INVALID');
  });

  it('requires a refresh_token in the body', async () => {
    const response = await request(app).post('/auth/refresh').send({});
    expect(response.status).toBe(400);
    expect(response.body.error_code).toBe('VALIDATION_ERROR');
  });

  it('signing out kills the refresh token, not just the access token', async () => {
    const userId = await registerUser();
    const signedIn = await signIn(userId, true);

    await revokeAuthSession(signedIn.access_token);

    expect(await readAuthSession(signedIn.access_token)).toBeNull();
    const attempt = await redeemRefreshToken(signedIn.refresh_token!);
    expect(attempt.ok).toBe(false);
  });

  it('refuses to refresh a session for an identity that no longer resolves', async () => {
    const issued = await issueAuthSession(
      {
        account_id: randomUUID(),
        user_id: 'never.registered@example.com',
        base_role: 'developer',
        role: 'developer',
        display_name: 'Ghost',
        auth_provider: 'local',
        source: 'custom'
      },
      { issue_refresh_token: true }
    );

    const attempt = await redeemRefreshToken(issued.refresh_token!);
    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(attempt.error_code).toBe('USER_NOT_FOUND');
  });
});
