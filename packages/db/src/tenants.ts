import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.ts";

/** Administrative operations. They run as the owner, outside any tenant context. */

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function createTenant(
  db: Db,
  opts: { name: string; orgDomains?: string[]; retentionDays?: number },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO tenants (name, org_domains, retention_days) VALUES ($1, $2, $3) RETURNING id",
    [opts.name, opts.orgDomains ?? [], opts.retentionDays ?? 30],
  );
  return rows[0]!.id;
}

/** Returns the plaintext key once. Only its SHA-256 is stored. */
export async function createApiKey(db: Db, tenantId: string, label = ""): Promise<string> {
  const key = `shk_${randomBytes(24).toString("base64url")}`;
  await db.query("INSERT INTO api_keys (tenant_id, key_sha256, label) VALUES ($1, $2, $3)", [
    tenantId,
    sha256(key),
    label,
  ]);
  return key;
}

export async function tenantForApiKey(db: Db, key: string): Promise<string | null> {
  const { rows } = await db.query<{ tenant_id: string }>(
    "SELECT tenant_id FROM api_keys WHERE key_sha256 = $1 AND revoked_at IS NULL",
    [sha256(key)],
  );
  return rows[0]?.tenant_id ?? null;
}

/**
 * Retention: nulls artifact bodies older than each tenant's retention window. The SHA-256 of the
 * body, the stored analyses (with their evidence quotes) and verification outcomes remain.
 */
export async function purgeBodies(db: Db, now = new Date()): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE artifacts a SET body = NULL, purged_at = $1
       FROM tenants t
      WHERE a.tenant_id = t.id AND a.body IS NOT NULL
        AND a.created_at < $1::timestamptz - make_interval(days => t.retention_days)
      RETURNING a.id`,
    [now.toISOString()],
  );
  return rows.length;
}
