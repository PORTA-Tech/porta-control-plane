import type { OrganizationProfile } from '@porta/api-contracts';
import { ensureFleetPersistenceReady, getFleetPersistenceMode, getFleetPool } from './fleetPersistence.js';

const organizationMemoryStore = new Map<string, OrganizationProfile>();

export async function upsertOrganizationProfile(profile: OrganizationProfile): Promise<void> {
  if (getFleetPersistenceMode() === 'memory') {
    organizationMemoryStore.set(profile.orgId, profile);
    return;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    organizationMemoryStore.set(profile.orgId, profile);
    return;
  }

  await pool.query(
    `
      INSERT INTO organizations (
        org_id,
        org_name,
        org_slug,
        plan_tier,
        billing_account_id,
        payload_json,
        created_at,
        updated_at
      ) VALUES (
        $1::uuid, $2, $3, $4, $5, $6::jsonb, $7::timestamptz, $8::timestamptz
      )
      ON CONFLICT (org_id) DO UPDATE SET
        org_name = EXCLUDED.org_name,
        org_slug = EXCLUDED.org_slug,
        plan_tier = EXCLUDED.plan_tier,
        billing_account_id = EXCLUDED.billing_account_id,
        payload_json = EXCLUDED.payload_json,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at;
    `,
    [
      profile.orgId,
      profile.orgName,
      profile.orgSlug ?? null,
      profile.planTier,
      profile.billingAccountId ?? null,
      JSON.stringify(profile),
      profile.createdAt,
      profile.updatedAt
    ]
  );
}

export async function getOrganizationProfile(orgId: string): Promise<OrganizationProfile | null> {
  if (getFleetPersistenceMode() === 'memory') {
    return organizationMemoryStore.get(orgId) ?? null;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return organizationMemoryStore.get(orgId) ?? null;
  }

  const result = await pool.query<{ payload_json: OrganizationProfile }>(
    `
      SELECT payload_json
      FROM organizations
      WHERE org_id = $1::uuid
      LIMIT 1;
    `,
    [orgId]
  );

  return result.rows[0]?.payload_json ?? null;
}

export async function listOrganizationProfiles(): Promise<OrganizationProfile[]> {
  if (getFleetPersistenceMode() === 'memory') {
    return Array.from(organizationMemoryStore.values()).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    return Array.from(organizationMemoryStore.values()).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  const result = await pool.query<{ payload_json: OrganizationProfile }>(
    `
      SELECT payload_json
      FROM organizations
      ORDER BY updated_at DESC, org_id ASC;
    `
  );

  return result.rows.map((row) => row.payload_json);
}

export async function deleteOrganizationProfile(orgId: string): Promise<void> {
  if (getFleetPersistenceMode() === 'memory') {
    organizationMemoryStore.delete(orgId);
    return;
  }

  await ensureFleetPersistenceReady();
  const pool = getFleetPool();
  if (!pool) {
    organizationMemoryStore.delete(orgId);
    return;
  }

  await pool.query(
    `
      DELETE FROM organizations
      WHERE org_id = $1::uuid;
    `,
    [orgId]
  );
}

export function clearOrganizationStoreForTests(): void {
  organizationMemoryStore.clear();
}
