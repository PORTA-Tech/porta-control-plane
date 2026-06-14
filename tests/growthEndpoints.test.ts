import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as supertest from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { registerAuthUser } from '../src/core/authSessionStore.js';
import {
  maybeActivateAccount,
  recordAccountActiveDay,
  recordLifecycleGrowthEvent
} from '../src/core/growthService.js';
import { resetSLOGateStateForTests } from '../src/core/sloEvaluator.js';
import { clearAccountStoreForTests, upsertAccountProfile } from '../src/store/accountStore.js';
import { clearAccountActiveDayStoreForTests } from '../src/store/accountActiveDayStore.js';
import { clearConsentRecordStoreForTests, upsertConsentRecord } from '../src/store/consentRecordStore.js';
import { clearDeviceStoreForTests, upsertDeviceProfile } from '../src/store/deviceStore.js';
import { clearGrowthEventStoreForTests } from '../src/store/growthEventStore.js';
import { clearMembershipStoreForTests, upsertMembership } from '../src/store/membershipStore.js';
import { clearOrganizationStoreForTests, upsertOrganizationProfile } from '../src/store/organizationStore.js';
import { loadRuntimeState, resetRuntimeStateForTests } from '../src/store/runtimeState.js';

const dataDir = path.resolve('.data');
const request = (supertest as unknown as { default: typeof supertest }).default as unknown as typeof import('supertest');
const app = createApp();

interface SeededGrowthUser {
  accountId: string;
  userId: string;
  orgId: string;
  deviceId: string;
  machineId: string;
  registrationDate: string;
}

const TEST_OPERATOR_KEY = 'test-operator-key-growth';

function withOperatorHeaders(req: supertest.Test): supertest.Test {
  return req
    .set('x-operator-id', 'operator-growth')
    .set('x-operator-role', 'operator')
    .set('x-operator-key', TEST_OPERATOR_KEY);
}

function addDays(date: string, delta: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + delta);
  return value.toISOString().slice(0, 10);
}

function utcDayOffset(delta: number): string {
  const today = new Date();
  const value = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  value.setUTCDate(value.getUTCDate() + delta);
  return value.toISOString().slice(0, 10);
}

async function seedGrowthUser(input: {
  label: string;
  registrationDate: string;
  activeDayOffsets: number[];
}): Promise<SeededGrowthUser> {
  const suffix = randomUUID().slice(0, 8);
  const userId = `${input.label}.${suffix}@growth.test`;
  const orgId = randomUUID();
  const deviceId = randomUUID();
  const membershipId = randomUUID();
  const consentId = randomUUID();
  const machineId = `machine-${suffix}`;

  const created = await registerAuthUser({
    user_id: userId,
    password: 'ValidPass1',
    display_name: `Growth ${input.label}`,
    role: 'developer'
  });

  if (!created.ok) {
    throw new Error(`Could not seed auth user ${userId}: ${created.error_code}`);
  }

  const accountId = created.user.account_id;
  const registrationAtUtc = `${input.registrationDate}T09:00:00.000Z`;
  const membershipJoinedAtUtc = `${input.registrationDate}T09:05:00.000Z`;
  const deviceLinkedAtUtc = `${input.registrationDate}T09:10:00.000Z`;
  const consentedAtUtc = `${input.registrationDate}T09:15:00.000Z`;

  await upsertAccountProfile({
    accountId,
    displayName: created.user.display_name,
    primaryEmail: userId,
    emailVerified: true,
    avatarUrl: null,
    status: 'active',
    authProvider: 'local',
    lastLoginAt: null,
    createdAt: registrationAtUtc,
    updatedAt: registrationAtUtc
  });

  await upsertOrganizationProfile({
    orgId,
    orgName: `Growth Org ${input.label}`,
    orgSlug: `growth-org-${input.label}-${suffix}`,
    planTier: 'pro',
    billingAccountId: `billing-${suffix}`,
    createdAt: registrationAtUtc,
    updatedAt: registrationAtUtc
  });

  await upsertMembership({
    membershipId,
    accountId,
    orgId,
    role: 'owner',
    status: 'active',
    invitedAt: null,
    joinedAt: membershipJoinedAtUtc,
    invitedByAccountId: null,
    createdAt: membershipJoinedAtUtc,
    updatedAt: membershipJoinedAtUtc
  });

  await upsertDeviceProfile({
    deviceId,
    orgId,
    machineName: `Growth Device ${input.label}`,
    deviceDisplayName: `Growth Device ${input.label}`,
    platform: 'windows',
    agentVersion: '1.0.0',
    status: 'active',
    firstSeenAt: deviceLinkedAtUtc,
    lastSeenAt: deviceLinkedAtUtc,
    currentAccountId: accountId,
    revokedAt: null,
    createdAt: deviceLinkedAtUtc,
    updatedAt: deviceLinkedAtUtc
  });

  await upsertConsentRecord({
    consentId,
    scope: 'device_capture',
    accountId,
    deviceId,
    orgId,
    consentVersion: 'v1',
    consentState: 'accepted',
    telemetryLevel: 'full',
    consentedAt: consentedAtUtc,
    updatedAt: consentedAtUtc
  });

  await recordLifecycleGrowthEvent({
    eventKey: `account_registered:${accountId}`,
    eventType: 'account_registered',
    accountId,
    userId,
    occurredAtUtc: registrationAtUtc,
    source: 'test_seed'
  });
  await recordLifecycleGrowthEvent({
    eventKey: `membership_joined:${accountId}:${orgId}`,
    eventType: 'membership_joined',
    accountId,
    userId,
    orgId,
    occurredAtUtc: membershipJoinedAtUtc,
    source: 'test_seed'
  });
  await recordLifecycleGrowthEvent({
    eventKey: `device_linked:${accountId}:${deviceId}:${orgId}`,
    eventType: 'device_linked',
    accountId,
    userId,
    deviceId,
    orgId,
    occurredAtUtc: deviceLinkedAtUtc,
    source: 'test_seed'
  });
  await recordLifecycleGrowthEvent({
    eventKey: `device_capture_consented:${accountId}:${deviceId}:${orgId}:${consentedAtUtc}`,
    eventType: 'device_capture_consented',
    accountId,
    userId,
    deviceId,
    orgId,
    occurredAtUtc: consentedAtUtc,
    source: 'test_seed'
  });

  for (const offset of input.activeDayOffsets) {
    const activityDate = addDays(input.registrationDate, offset);
    await recordAccountActiveDay({
      accountId,
      userId,
      orgId,
      machineId,
      activityAtUtc: `${activityDate}T12:00:00.000Z`,
      source: 'test_seed'
    });
  }

  await maybeActivateAccount(accountId);

  return {
    accountId,
    userId,
    orgId,
    deviceId,
    machineId,
    registrationDate: input.registrationDate
  };
}

describe('growth endpoints', () => {
  beforeEach(() => {
    process.env.PORTA_OPERATOR_KEY = TEST_OPERATOR_KEY;
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    resetRuntimeStateForTests();
    resetSLOGateStateForTests();
    clearAccountStoreForTests();
    clearAccountActiveDayStoreForTests();
    clearConsentRecordStoreForTests();
    clearDeviceStoreForTests();
    clearGrowthEventStoreForTests();
    clearMembershipStoreForTests();
    clearOrganizationStoreForTests();
    loadRuntimeState();
  });

  it('serves growth summary, series, cohorts, and journey from custom-user lifecycle facts', async () => {
    const oldCohortDate = utcDayOffset(-10);
    const recentCohortDate = utcDayOffset(-2);
    const oneDayAgo = utcDayOffset(-1);

    const oldRetained = await seedGrowthUser({
      label: 'old-retained',
      registrationDate: oldCohortDate,
      activeDayOffsets: [0, 1, 7]
    });
    await seedGrowthUser({
      label: 'old-churned',
      registrationDate: oldCohortDate,
      activeDayOffsets: [0]
    });
    await seedGrowthUser({
      label: 'recent-retained',
      registrationDate: recentCohortDate,
      activeDayOffsets: [0, 1]
    });
    await seedGrowthUser({
      label: 'recent-unactivated',
      registrationDate: oneDayAgo,
      activeDayOffsets: []
    });

    const summaryResponse = await withOperatorHeaders(request(app).get('/v1/growth/summary'));
    expect(summaryResponse.status).toBe(200);
    expect(summaryResponse.body.timezone).toBe('UTC');
    expect(summaryResponse.body.total_registered_users).toBe(4);
    expect(summaryResponse.body.new_registered_users).toBe(4);
    expect(summaryResponse.body.activated_users).toBe(3);
    expect(summaryResponse.body.activation_rate_pct).toBe(75);
    expect(summaryResponse.body.retention_rate_d1_pct).toBeCloseTo(66.67, 2);
    expect(summaryResponse.body.churn_rate_d1_pct).toBeCloseTo(33.33, 2);
    expect(summaryResponse.body.retention_rate_d7_pct).toBe(50);
    expect(summaryResponse.body.churn_rate_d7_pct).toBe(50);
    expect(summaryResponse.body.retention_rate_d30_pct).toBeNull();
    expect(summaryResponse.body.churn_rate_d30_pct).toBeNull();

    const registrationsSeries = await withOperatorHeaders(
      request(app).get('/v1/growth/series').query({
        metric: 'registrations',
        interval: 'day',
        from: `${oldCohortDate}T00:00:00.000Z`,
        to: `${oneDayAgo}T23:59:59.999Z`
      })
    );
    expect(registrationsSeries.status).toBe(200);
    const registrationPoints = new Map<string, number>(
      registrationsSeries.body.points.map((point: { bucket_start_utc: string; value: number }) => [point.bucket_start_utc.slice(0, 10), point.value])
    );
    expect(registrationPoints.get(oldCohortDate)).toBe(2);
    expect(registrationPoints.get(recentCohortDate)).toBe(1);
    expect(registrationPoints.get(oneDayAgo)).toBe(1);

    const activeUsersSeries = await withOperatorHeaders(
      request(app).get('/v1/growth/series').query({
        metric: 'active_users',
        interval: 'day',
        from: `${oldCohortDate}T00:00:00.000Z`,
        to: `${addDays(oldCohortDate, 7)}T23:59:59.999Z`
      })
    );
    expect(activeUsersSeries.status).toBe(200);
    const activeUserPoints = new Map<string, number>(
      activeUsersSeries.body.points.map((point: { bucket_start_utc: string; value: number }) => [point.bucket_start_utc.slice(0, 10), point.value])
    );
    expect(activeUserPoints.get(addDays(oldCohortDate, 1))).toBe(1);
    expect(activeUserPoints.get(addDays(oldCohortDate, 7))).toBe(1);

    const cohortsResponse = await withOperatorHeaders(
      request(app).get('/v1/growth/cohorts').query({ limit: 10 })
    );
    expect(cohortsResponse.status).toBe(200);
    const cohortRows = new Map<string, {
      registered_users: number;
      activated_users: number;
      windows: Array<{
        day: number;
        eligible_users: number;
        retained_users: number;
        retention_rate_pct: number | null;
        churn_rate_pct: number | null;
      }>;
    }>(
      cohortsResponse.body.rows.map((row: {
        cohort_date: string;
        registered_users: number;
        activated_users: number;
        windows: Array<{
          day: number;
          eligible_users: number;
          retained_users: number;
          retention_rate_pct: number | null;
          churn_rate_pct: number | null;
        }>;
      }) => [row.cohort_date, row])
    );

    const oldCohort = cohortRows.get(oldCohortDate);
    expect(oldCohort?.registered_users).toBe(2);
    expect(oldCohort?.activated_users).toBe(2);
    const oldD1 = oldCohort?.windows.find((window) => window.day === 1);
    expect(oldD1?.eligible_users).toBe(2);
    expect(oldD1?.retained_users).toBe(1);
    expect(oldD1?.retention_rate_pct).toBe(50);
    const oldD7 = oldCohort?.windows.find((window) => window.day === 7);
    expect(oldD7?.eligible_users).toBe(2);
    expect(oldD7?.retained_users).toBe(1);
    expect(oldD7?.retention_rate_pct).toBe(50);
    const oldD30 = oldCohort?.windows.find((window) => window.day === 30);
    expect(oldD30?.retention_rate_pct).toBeNull();
    expect(oldD30?.churn_rate_pct).toBeNull();

    const journeyResponse = await withOperatorHeaders(
      request(app).get(`/v1/growth/users/${oldRetained.accountId}/journey`)
    );
    expect(journeyResponse.status).toBe(200);
    expect(journeyResponse.body.account_id).toBe(oldRetained.accountId);
    expect(journeyResponse.body.user_id).toBe(oldRetained.userId);
    expect(journeyResponse.body.source).toBe('custom');
    expect(journeyResponse.body.registration_at_utc).toBe(`${oldCohortDate}T09:00:00.000Z`);
    expect(journeyResponse.body.activation_at_utc).toBe(`${oldCohortDate}T12:00:00.000Z`);
    expect(journeyResponse.body.active_days).toEqual([
      oldCohortDate,
      addDays(oldCohortDate, 1),
      addDays(oldCohortDate, 7)
    ]);
    expect(
      journeyResponse.body.events.map((event: { event_type: string }) => event.event_type)
    ).toEqual([
      'account_registered',
      'membership_joined',
      'device_linked',
      'device_capture_consented',
      'account_activated',
      'account_active_day',
      'account_active_day',
      'account_active_day'
    ]);
  });
});ed',
      'device_capture_consented',
      'account_activated',
      'account_active_day',
      'account_active_day',
      'account_active_day'
    ]);
  });
});
