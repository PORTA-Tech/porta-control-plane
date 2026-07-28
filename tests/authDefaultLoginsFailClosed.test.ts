import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authenticateUser,
  reloadBaseUsersForTests,
} from '../src/core/authSessionStore.js';

// Regression guard for the default-credential hole: with AUTH_USERS_JSON unset in
// production, loadBaseUsers() used to return the source-defined admin/operator/...
// table, making admin/porta-admin a live admin login on the deployed control plane.
// The rule these tests pin: a password compiled into source can never authenticate
// in production, and is off by default everywhere else.

const AUTH_ENV_KEYS = ['NODE_ENV', 'AUTH_USERS_JSON', 'PORTA_ENABLE_DEFAULT_LOGINS'] as const;

describe('built-in default logins fail closed', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(AUTH_ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of AUTH_ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of AUTH_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    reloadBaseUsersForTests();
  });

  it('rejects admin/porta-admin in production when AUTH_USERS_JSON is unset', async () => {
    process.env.NODE_ENV = 'production';
    reloadBaseUsersForTests();

    expect(await authenticateUser('admin', 'porta-admin')).toBeNull();
    expect(await authenticateUser('operator', 'porta-operator')).toBeNull();
    expect(await authenticateUser('auditor', 'porta-auditor')).toBeNull();
    expect(await authenticateUser('developer', 'porta-developer')).toBeNull();
  });

  it('still rejects them in production even if PORTA_ENABLE_DEFAULT_LOGINS is set', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PORTA_ENABLE_DEFAULT_LOGINS = 'true';
    reloadBaseUsersForTests();

    // The flag is a dev convenience; production must ignore it. A misconfigured
    // Render env must not be able to re-open the hole.
    expect(await authenticateUser('admin', 'porta-admin')).toBeNull();
  });

  it('rejects them in a non-production runtime when the flag is not set', async () => {
    process.env.NODE_ENV = 'development';
    reloadBaseUsersForTests();

    expect(await authenticateUser('admin', 'porta-admin')).toBeNull();
  });

  it('allows them in a non-production runtime only when the flag is explicitly set', async () => {
    process.env.NODE_ENV = 'development';
    process.env.PORTA_ENABLE_DEFAULT_LOGINS = 'true';
    reloadBaseUsersForTests();

    const admin = await authenticateUser('admin', 'porta-admin');
    expect(admin).not.toBeNull();
    expect(admin?.role).toBe('admin');
  });

  it('honors an explicit AUTH_USERS_JSON in production, but not the compiled defaults', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_USERS_JSON = JSON.stringify([
      { user_id: 'ops-real', password: 'Configured-Pass-123', role: 'operator' },
    ]);
    reloadBaseUsersForTests();

    const configured = await authenticateUser('ops-real', 'Configured-Pass-123');
    expect(configured).not.toBeNull();
    expect(configured?.role).toBe('operator');

    // The built-in table must not ride along with an explicit config.
    expect(await authenticateUser('admin', 'porta-admin')).toBeNull();
  });
});
