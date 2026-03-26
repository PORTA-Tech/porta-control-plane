import type {
  GrowthCohortRow,
  GrowthCohortWindow,
  GrowthCohorts,
  GrowthSeries,
  GrowthSeriesInterval,
  GrowthSeriesMetric,
  GrowthSummary,
  GrowthUserJourney,
  GrowthUserJourneyEvent,
  GrowthUserSource
} from '@porta/api-contracts';
import { readAuthUserIdentity } from './authSessionStore.js';
import { listAuthUserRecords } from '../store/authUserStore.js';
import { listAccountProfiles } from '../store/accountStore.js';
import { getFleetPersistenceMode } from '../store/fleetPersistence.js';
import { listGrowthEvents, listGrowthEventsForAccount, type GrowthEventRecord } from '../store/growthEventStore.js';
import {
  listAccountActiveDays,
  listAccountActiveDaysForAccount,
  type AccountActiveDayRecord
} from '../store/accountActiveDayStore.js';

const UTC_TIMEZONE = 'UTC';
const DEFAULT_SUMMARY_WINDOW_DAYS = 30;
const DEFAULT_COHORT_LIMIT = 30;
const DEFAULT_SERIES_BUCKETS: Record<GrowthSeriesInterval, number> = {
  day: 30,
  week: 12,
  month: 12
};
const COHORT_WINDOWS = [1, 7, 30] as const;

interface GrowthAccountView {
  accountId: string;
  userId: string;
  source: GrowthUserSource;
  registrationAtUtc: string;
}

interface GrowthDataset {
  accounts: GrowthAccountView[];
  accountById: Map<string, GrowthAccountView>;
  activationAtByAccountId: Map<string, string>;
  activeDayRecordsByAccountId: Map<string, AccountActiveDayRecord[]>;
  activeDayDatesByAccountId: Map<string, Set<string>>;
  activeDayRecords: AccountActiveDayRecord[];
  eventsByAccountId: Map<string, GrowthEventRecord[]>;
  earliestActiveCoverageDate: string | null;
}

interface RetentionAggregate {
  eligibleUsers: number;
  retainedUsers: number;
  retentionRatePct: number | null;
  churnRatePct: number | null;
}

interface CohortRangeOptions {
  fromDate?: string | null;
  toDate?: string | null;
  limit?: number | null;
}

interface SeriesRange {
  from: Date;
  to: Date;
}

function looksLikeSelfServeUserId(userId: string): boolean {
  return userId.includes('@');
}

function normalizeTimestamp(input: string): string {
  const parsed = Date.parse(input);
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}

function parseDateTime(input: string | null | undefined): Date | null {
  const trimmed = input?.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

function normalizeDate(input: string | number | Date): string {
  if (input instanceof Date) {
    return toUtcDateString(input);
  }

  if (typeof input === 'number') {
    return Number.isFinite(input) ? new Date(input).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  }

  const trimmed = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? new Date().toISOString().slice(0, 10) : new Date(parsed).toISOString().slice(0, 10);
}

function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateFromDateString(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function compareDateStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function addDays(date: string, delta: number): string {
  const value = dateFromDateString(date);
  value.setUTCDate(value.getUTCDate() + delta);
  return toUtcDateString(value);
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfUtcWeek(date: Date): Date {
  const start = startOfUtcDay(date);
  const dayOffset = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - dayOffset);
  return start;
}

function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function startOfInterval(date: Date, interval: GrowthSeriesInterval): Date {
  switch (interval) {
    case 'week':
      return startOfUtcWeek(date);
    case 'month':
      return startOfUtcMonth(date);
    case 'day':
    default:
      return startOfUtcDay(date);
  }
}

function addInterval(date: Date, interval: GrowthSeriesInterval, delta: number): Date {
  const next = new Date(date.getTime());
  switch (interval) {
    case 'week':
      next.setUTCDate(next.getUTCDate() + (delta * 7));
      return next;
    case 'month':
      next.setUTCMonth(next.getUTCMonth() + delta);
      return next;
    case 'day':
    default:
      next.setUTCDate(next.getUTCDate() + delta);
      return next;
  }
}

function minTimestamp(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function maxTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function roundPct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) {
    return null;
  }

  return Math.round((numerator / denominator) * 10_000) / 100;
}

function uniqueSortedDates(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareDateStrings);
}

async function listGrowthAccounts(): Promise<GrowthAccountView[]> {
  if (getFleetPersistenceMode() === 'postgres') {
    const [authUsers, accounts] = await Promise.all([
      listAuthUserRecords(),
      listAccountProfiles()
    ]);

    const accountById = new Map(accounts.map((account) => [account.accountId, account]));
    const growthAccounts = authUsers
      .filter((user) => user.source === 'custom')
      .map((user) => ({
        accountId: user.account_id,
        userId: user.user_id,
        source: user.source,
        registrationAtUtc: normalizeTimestamp(accountById.get(user.account_id)?.createdAt ?? user.created_at)
      }));

    const seenAccountIds = new Set(growthAccounts.map((account) => account.accountId));
    for (const account of accounts) {
      if (seenAccountIds.has(account.accountId) || !looksLikeSelfServeUserId(account.primaryEmail)) {
        continue;
      }

      growthAccounts.push({
        accountId: account.accountId,
        userId: account.primaryEmail,
        source: 'custom',
        registrationAtUtc: normalizeTimestamp(account.createdAt)
      });
    }

    return growthAccounts
      .sort((left, right) => Date.parse(left.registrationAtUtc) - Date.parse(right.registrationAtUtc));
  }

  const accounts = await listAccountProfiles();
  const identities = await Promise.all(
    accounts.map(async (account) => ({
      account,
      identity: await readAuthUserIdentity(account.primaryEmail)
    }))
  );

  return identities
    .filter((row): row is typeof row & { identity: NonNullable<typeof row.identity> } => row.identity !== null)
    .filter((row) => row.identity.source === 'custom')
    .map((row) => ({
      accountId: row.account.accountId,
      userId: row.identity.user_id,
      source: row.identity.source,
      registrationAtUtc: normalizeTimestamp(row.account.createdAt)
    }))
    .sort((left, right) => Date.parse(left.registrationAtUtc) - Date.parse(right.registrationAtUtc));
}

async function loadGrowthDataset(): Promise<GrowthDataset> {
  const [accounts, growthEvents, activeDayRecords] = await Promise.all([
    listGrowthAccounts(),
    listGrowthEvents(),
    listAccountActiveDays()
  ]);

  const accountById = new Map(accounts.map((account) => [account.accountId, account]));
  const allowedAccountIds = new Set(accountById.keys());

  const activationAtByAccountId = new Map<string, string>();
  const eventsByAccountId = new Map<string, GrowthEventRecord[]>();
  for (const event of growthEvents) {
    const accountId = event.accountId ?? null;
    if (!accountId || !allowedAccountIds.has(accountId)) {
      continue;
    }

    const bucket = eventsByAccountId.get(accountId) ?? [];
    bucket.push(event);
    eventsByAccountId.set(accountId, bucket);

    if (event.eventType === 'account_activated' && !activationAtByAccountId.has(accountId)) {
      activationAtByAccountId.set(accountId, event.occurredAtUtc);
    }
  }

  const filteredActiveDays = activeDayRecords.filter((record) => allowedAccountIds.has(record.accountId));
  const activeDayRecordsByAccountId = new Map<string, AccountActiveDayRecord[]>();
  const activeDayDatesByAccountId = new Map<string, Set<string>>();
  for (const record of filteredActiveDays) {
    const records = activeDayRecordsByAccountId.get(record.accountId) ?? [];
    records.push(record);
    activeDayRecordsByAccountId.set(record.accountId, records);

    const dates = activeDayDatesByAccountId.get(record.accountId) ?? new Set<string>();
    dates.add(record.activityDate);
    activeDayDatesByAccountId.set(record.accountId, dates);
  }

  const earliestActiveCoverageDate = filteredActiveDays
    .map((record) => record.activityDate)
    .sort(compareDateStrings)[0] ?? null;

  return {
    accounts,
    accountById,
    activationAtByAccountId,
    activeDayRecordsByAccountId,
    activeDayDatesByAccountId,
    activeDayRecords: filteredActiveDays,
    eventsByAccountId,
    earliestActiveCoverageDate
  };
}

function isRegistrationWithinRange(registrationAtUtc: string, windowStartUtc: string, windowEndUtc: string): boolean {
  const registrationMs = Date.parse(registrationAtUtc);
  return registrationMs >= Date.parse(windowStartUtc) && registrationMs <= Date.parse(windowEndUtc);
}

function aggregateRetention(rows: GrowthCohortRow[], day: number): RetentionAggregate {
  let eligibleUsers = 0;
  let retainedUsers = 0;

  for (const row of rows) {
    const window = row.windows.find((entry) => entry.day === day);
    if (!window || window.retentionRatePct === null || window.churnRatePct === null) {
      continue;
    }

    eligibleUsers += window.eligibleUsers;
    retainedUsers += window.retainedUsers;
  }

  return {
    eligibleUsers,
    retainedUsers,
    retentionRatePct: roundPct(retainedUsers, eligibleUsers),
    churnRatePct: roundPct(eligibleUsers - retainedUsers, eligibleUsers)
  };
}

function resolveSummaryWindow(windowDays: number | null | undefined): { startUtc: string; endUtc: string; startDate: string; endDate: string } {
  const boundedWindowDays = Math.max(1, Math.trunc(windowDays ?? DEFAULT_SUMMARY_WINDOW_DAYS));
  const end = new Date();
  const endDate = toUtcDateString(end);
  const startDate = addDays(endDate, -(boundedWindowDays - 1));
  return {
    startUtc: `${startDate}T00:00:00.000Z`,
    endUtc: end.toISOString(),
    startDate,
    endDate
  };
}

function resolveSeriesRange(
  interval: GrowthSeriesInterval,
  fromInput?: string | null,
  toInput?: string | null
): SeriesRange | null {
  const to = parseDateTime(toInput) ?? new Date();
  const from = parseDateTime(fromInput)
    ?? addInterval(startOfInterval(to, interval), interval, -(DEFAULT_SERIES_BUCKETS[interval] - 1));

  if (from.getTime() > to.getTime()) {
    return null;
  }

  return { from, to };
}

function overlapsWindow(
  startUtc: string,
  endUtc: string,
  windowStartMs: number,
  windowEndExclusiveMs: number
): boolean {
  const startMs = Date.parse(startUtc);
  const endMs = Date.parse(endUtc);
  return startMs < windowEndExclusiveMs && endMs >= windowStartMs;
}

function buildCohortRows(dataset: GrowthDataset, options: CohortRangeOptions = {}): GrowthCohortRow[] {
  const rowsByDate = new Map<string, GrowthAccountView[]>();
  for (const account of dataset.accounts) {
    const cohortDate = normalizeDate(account.registrationAtUtc);
    const bucket = rowsByDate.get(cohortDate) ?? [];
    bucket.push(account);
    rowsByDate.set(cohortDate, bucket);
  }

  const todayDate = toUtcDateString(new Date());
  const cohortDates = [...rowsByDate.keys()].sort(compareDateStrings);
  const filteredDates = cohortDates.filter((date) => {
    if (options.fromDate && compareDateStrings(date, options.fromDate) < 0) {
      return false;
    }
    if (options.toDate && compareDateStrings(date, options.toDate) > 0) {
      return false;
    }
    return true;
  });

  const limitedDates = options.limit && options.limit > 0
    ? filteredDates.slice(Math.max(0, filteredDates.length - options.limit))
    : filteredDates;

  return limitedDates.map((cohortDate) => {
    const cohortAccounts = rowsByDate.get(cohortDate) ?? [];
    const activatedAccounts = cohortAccounts.filter((account) => dataset.activationAtByAccountId.has(account.accountId));

    const windows: GrowthCohortWindow[] = COHORT_WINDOWS.map((day) => {
      const targetDate = addDays(cohortDate, day);
      const hasCoverage = Boolean(
        dataset.earliestActiveCoverageDate
        && compareDateStrings(targetDate, dataset.earliestActiveCoverageDate) >= 0
        && compareDateStrings(targetDate, todayDate) <= 0
      );

      if (!hasCoverage) {
        return {
          day,
          eligibleUsers: 0,
          retainedUsers: 0,
          retentionRatePct: null,
          churnedUsers: 0,
          churnRatePct: null
        };
      }

      const eligibleAccounts = activatedAccounts.filter((account) => {
        const activationAt = dataset.activationAtByAccountId.get(account.accountId);
        return Boolean(activationAt && compareDateStrings(normalizeDate(activationAt), targetDate) <= 0);
      });

      const retainedUsers = eligibleAccounts.filter((account) =>
        dataset.activeDayDatesByAccountId.get(account.accountId)?.has(targetDate) ?? false).length;

      return {
        day,
        eligibleUsers: eligibleAccounts.length,
        retainedUsers,
        retentionRatePct: roundPct(retainedUsers, eligibleAccounts.length),
        churnedUsers: Math.max(0, eligibleAccounts.length - retainedUsers),
        churnRatePct: roundPct(eligibleAccounts.length - retainedUsers, eligibleAccounts.length)
      };
    });

    return {
      cohortDate,
      registeredUsers: cohortAccounts.length,
      activatedUsers: activatedAccounts.length,
      windows
    };
  });
}

export async function readGrowthSummary(windowDays?: number | null): Promise<GrowthSummary> {
  const dataset = await loadGrowthDataset();
  const window = resolveSummaryWindow(windowDays);
  const rows = buildCohortRows(dataset, {
    fromDate: window.startDate,
    toDate: window.endDate
  });

  const newRegisteredUsers = dataset.accounts.filter((account) =>
    isRegistrationWithinRange(account.registrationAtUtc, window.startUtc, window.endUtc)).length;
  const activatedUsers = dataset.accounts.filter((account) => {
    const activationAt = dataset.activationAtByAccountId.get(account.accountId);
    return Boolean(activationAt && isRegistrationWithinRange(activationAt, window.startUtc, window.endUtc));
  }).length;

  const d1 = aggregateRetention(rows, 1);
  const d7 = aggregateRetention(rows, 7);
  const d30 = aggregateRetention(rows, 30);

  return {
    timezone: UTC_TIMEZONE,
    generatedAtUtc: new Date().toISOString(),
    windowStartUtc: window.startUtc,
    windowEndUtc: window.endUtc,
    totalRegisteredUsers: dataset.accounts.length,
    newRegisteredUsers,
    activatedUsers,
    activationRatePct: roundPct(activatedUsers, newRegisteredUsers),
    retentionRateD1Pct: d1.retentionRatePct,
    retentionRateD7Pct: d7.retentionRatePct,
    retentionRateD30Pct: d30.retentionRatePct,
    churnRateD1Pct: d1.churnRatePct,
    churnRateD7Pct: d7.churnRatePct,
    churnRateD30Pct: d30.churnRatePct
  };
}

export async function readGrowthSeries(options: {
  metric: GrowthSeriesMetric;
  interval?: GrowthSeriesInterval | null;
  from?: string | null;
  to?: string | null;
}): Promise<GrowthSeries | null> {
  const interval = options.interval ?? 'day';
  const range = resolveSeriesRange(interval, options.from, options.to);
  if (!range) {
    return null;
  }

  const dataset = await loadGrowthDataset();
  const toExclusive = new Date(range.to.getTime() + 1);
  const points: GrowthSeries['points'] = [];

  for (
    let bucketStart = startOfInterval(range.from, interval);
    bucketStart.getTime() <= range.to.getTime();
    bucketStart = addInterval(bucketStart, interval, 1)
  ) {
    const fullBucketEnd = addInterval(bucketStart, interval, 1);
    const clippedStart = new Date(Math.max(bucketStart.getTime(), range.from.getTime()));
    const clippedEnd = new Date(Math.min(fullBucketEnd.getTime(), toExclusive.getTime()));

    let value = 0;
    if (options.metric === 'registrations') {
      value = dataset.accounts.filter((account) => {
        const timestamp = Date.parse(account.registrationAtUtc);
        return timestamp >= clippedStart.getTime() && timestamp < clippedEnd.getTime();
      }).length;
    } else if (options.metric === 'activations') {
      value = dataset.accounts.filter((account) => {
        const activationAt = dataset.activationAtByAccountId.get(account.accountId);
        if (!activationAt) {
          return false;
        }

        const timestamp = Date.parse(activationAt);
        return timestamp >= clippedStart.getTime() && timestamp < clippedEnd.getTime();
      }).length;
    } else {
      const activeAccounts = new Set<string>();
      for (const record of dataset.activeDayRecords) {
        if (overlapsWindow(
          record.firstActivityAtUtc,
          record.lastActivityAtUtc,
          clippedStart.getTime(),
          clippedEnd.getTime()
        )) {
          activeAccounts.add(record.accountId);
        }
      }
      value = activeAccounts.size;
    }

    points.push({
      bucketStartUtc: bucketStart.toISOString(),
      bucketEndUtc: clippedEnd.toISOString(),
      value
    });
  }

  return {
    metric: options.metric,
    interval,
    timezone: UTC_TIMEZONE,
    points
  };
}

export async function readGrowthCohorts(options: CohortRangeOptions = {}): Promise<GrowthCohorts> {
  const dataset = await loadGrowthDataset();
  const rows = buildCohortRows(dataset, {
    ...(options.fromDate ? { fromDate: normalizeDate(options.fromDate) } : {}),
    ...(options.toDate ? { toDate: normalizeDate(options.toDate) } : {}),
    limit: options.limit ?? DEFAULT_COHORT_LIMIT
  });

  return {
    timezone: UTC_TIMEZONE,
    rows
  };
}

function toJourneyEvent(record: GrowthEventRecord): GrowthUserJourneyEvent {
  return {
    eventType: record.eventType,
    occurredAtUtc: record.occurredAtUtc,
    ...(record.activityDate ? { activityDate: record.activityDate } : {}),
    ...(record.deviceId !== undefined ? { deviceId: record.deviceId ?? null } : {}),
    ...(record.orgId !== undefined ? { orgId: record.orgId ?? null } : {}),
    ...(record.machineId !== undefined ? { machineId: record.machineId ?? null } : {}),
    ...(record.metadata ? { metadata: record.metadata } : {})
  };
}

export async function readGrowthUserJourney(accountId: string): Promise<GrowthUserJourney | null> {
  const dataset = await loadGrowthDataset();
  const account = dataset.accountById.get(accountId);
  if (!account) {
    return null;
  }

  const [events, activeDays] = await Promise.all([
    listGrowthEventsForAccount(accountId),
    listAccountActiveDaysForAccount(accountId)
  ]);

  const filteredEvents = events.filter((record) => record.accountId === accountId);
  const activationAtUtc = dataset.activationAtByAccountId.get(accountId) ?? null;

  return {
    accountId,
    userId: account.userId,
    source: account.source,
    registrationAtUtc: account.registrationAtUtc,
    activationAtUtc,
    events: filteredEvents.map(toJourneyEvent),
    activeDays: uniqueSortedDates(activeDays.map((record) => record.activityDate))
  };
}
