import type { Membership } from '@porta/api-contracts';
import { ensureFleetPersistenceReady, getFleetPersistenceMode, getFleetPool } from './fleetPersistence.js';

const membershipMemoryStore = new Map<string, Membership>();

export async function upsertMembership(membership: Membership): Promise<void> {
  if (getFleetPersistenceMode() === 'memory') {
    membershipMemoryStore.set(membership.membershipId, membership);
    return;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    membershipMemoryStore.set(membership.membershipId, membership);
    return;
  }

  await pool.query(
    `
      INSERT INTO memberships (
        membership_id,
        account_id,
        org_id,
        role,
        status,
        invited_at,
        joined_at,
        invited_by_account_id,
        payload_json,
        created_at,
        updated_at
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz, $7::timestamptz, $8::uuid, $9::jsonb, $10::timestamptz, $11::timestamptz
      )
      ON CONFLICT (membership_id) DO UPDATE SET
        account_id = EXCLUDED.account_id,
        org_id = EXCLUDED.org_id,
        role = EXCLUDED.role,
        status = EXCLUDED.status,
        invited_at = EXCLUDED.invited_at,
        joined_at = EXCLUDED.joined_at,
        invited_by_account_id = EXCLUDED.invited_by_account_id,
        payload_json = EXCLUDED.payload_json,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at;
    `,
    [
      membership.membershipId,
      membership.accountId,
      membership.orgId,
      membership.role,
      membership.status,
      membership.invitedAt ?? null,
      membership.joinedAt ?? null,
      membership.invitedByAccountId ?? null,
      JSON.stringify(membership),
      membership.createdAt,
      membership.updatedAt
    ]
  );
}

export async function getMembership(membershipId: string): Promise<Membership | null> {
  if (getFleetPersistenceMode() === 'memory') {
    return membershipMemoryStore.get(membershipId) ?? null;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return membershipMemoryStore.get(membershipId) ?? null;
  }

  const result = await pool.query<{ payload_json: Membership }>(
    `
      SELECT payload_json
      FROM memberships
      WHERE membership_id = $1::uuid
      LIMIT 1;
    `,
    [membershipId]
  );

  return result.rows[0]?.payload_json ?? null;
}

export async function listMemberships(): Promise<Membership[]> {
  if (getFleetPersistenceMode() === 'memory') {
    return Array.from(membershipMemoryStore.values()).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return Array.from(membershipMemoryStore.values()).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  const result = await pool.query<{ payload_json: Membership }>(
    `
      SELECT payload_json
      FROM memberships
      ORDER BY updated_at DESC, membership_id ASC;
    `
  );

  return result.rows.map((row) => row.payload_json);
}

export async function listMembershipsForAccount(accountId: string): Promise<Membership[]> {
  if (getFleetPersistenceMode() === 'memory') {
    return Array.from(membershipMemoryStore.values())
      .filter((membership) => membership.accountId === accountId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return Array.from(membershipMemoryStore.values())
      .filter((membership) => membership.accountId === accountId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  const result = await pool.query<{ payload_json: Membership }>(
    `
      SELECT payload_json
      FROM memberships
      WHERE account_id = $1::uuid
      ORDER BY updated_at DESC, membership_id ASC;
    `,
    [accountId]
  );

  return result.rows.map((row) => row.payload_json);
}

export async function listMembershipsForOrganization(orgId: string): Promise<Membership[]> {
  if (getFleetPersistenceMode() === 'memory') {
    return Array.from(membershipMemoryStore.values())
      .filter((membership) => membership.orgId === orgId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return Array.from(membershipMemoryStore.values())
      .filter((membership) => membership.orgId === orgId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  const result = await pool.query<{ payload_json: Membership }>(
    `
      SELECT payload_json
      FROM memberships
      WHERE org_id = $1::uuid
      ORDER BY updated_at DESC, membership_id ASC;
    `,
    [orgId]
  );

  return result.rows.map((row) => row.payload_json);
}

export async function deleteMembership(membershipId: string): Promise<void> {
  if (getFleetPersistenceMode() === 'memory') {
    membershipMemoryStore.delete(membershipId);
    return;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    membershipMemoryStore.delete(membershipId);
    return;
  }

  await pool.query(
    `
      DELETE FROM memberships
      WHERE membership_id = $1::uuid;
    `,
    [membershipId]
  );
}

export function clearMembershipStoreForTests(): void {
  membershipMemoryStore.clear();
}
