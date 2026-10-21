import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTenant,
  migrate,
  openTestDb,
  purgeBodies,
  splitSql,
  withTenant,
  type Db,
} from "../src/index.ts";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
let db: Db;

beforeAll(async () => {
  db = await openTestDb();
  await migrate(db);
});
afterAll(() => db.close());

describe("migrations", () => {
  it("apply once and are idempotent", async () => {
    expect(await migrate(db)).toEqual([]);
    const { rows } = await db.query<{ name: string }>("SELECT name FROM schema_migrations");
    expect(rows.map((r) => r.name)).toEqual([
      "001_init.sql",
      "002_review.sql",
      "003_app_role_access.sql",
    ]);
  });

  it("split SQL safely around $$ blocks, quotes and comments", () => {
    expect(splitSql("SELECT ';'; -- a; comment\nDO $$ BEGIN PERFORM 1; END $$; SELECT 2")).toEqual([
      "SELECT ';'",
      "DO $$ BEGIN PERFORM 1; END $$",
      "SELECT 2",
    ]);
  });
});

describe("tenant isolation (row-level security)", () => {
  it("a tenant sees only its own rows, whatever the query says", async () => {
    const a = await createTenant(db, { name: "A" });
    const b = await createTenant(db, { name: "B" });
    for (const t of [a, b])
      await withTenant(db, t, (tx) =>
        tx.query("INSERT INTO requests (tenant_id) VALUES ($1)", [t]),
      );
    const seenByA = await withTenant(db, a, (tx) =>
      tx.query<{ tenant_id: string }>("SELECT tenant_id FROM requests"),
    );
    expect(seenByA.rows.map((r) => r.tenant_id)).toEqual([a]);
    await expect(
      withTenant(db, a, (tx) => tx.query("INSERT INTO requests (tenant_id) VALUES ($1)", [b])),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("retention", () => {
  it("purges bodies past the tenant's window and keeps the hash", async () => {
    const t = await createTenant(db, { name: "R", retentionDays: 30 });
    await withTenant(db, t, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        "INSERT INTO requests (tenant_id) VALUES ($1) RETURNING id",
        [t],
      );
      await tx.query(
        "INSERT INTO artifacts (tenant_id, request_id, channel, body, body_sha256, created_at) VALUES ($1, $2, 'email', 'old', 'h1', now() - interval '40 days'), ($1, $2, 'email', 'new', 'h2', now())",
        [t, rows[0]!.id],
      );
    });
    expect(await purgeBodies(db)).toBeGreaterThanOrEqual(1);
    const left = await withTenant(db, t, (tx) =>
      tx.query<{ body: string | null; body_sha256: string }>(
        "SELECT body, body_sha256 FROM artifacts ORDER BY body_sha256",
      ),
    );
    expect(left.rows).toEqual([
      { body: null, body_sha256: "h1" },
      { body: "new", body_sha256: "h2" },
    ]);
  });
});

describe("principle 2 in the schema", () => {
  it("no column models a recipient, an employee or a per-person score", () => {
    const sql = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(path.join(MIGRATIONS, f), "utf8").replace(/--.*$/gm, ""))
      .join("\n");
    const forbidden =
      /\b(recipient\w*|to_address|cc|bcc|employee\w*|user_id|person\w*|\w*risk_score|\w*_score)\b/gi;
    expect(sql.match(forbidden) ?? []).toEqual([]);
    // actor_ref is the single, audited exception.
    const tables = [...sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)];
    const withActor = tables
      .filter(([, , body]) => /\bactor_ref\b/.test(body!))
      .map(([, name]) => name);
    expect(withActor).toEqual(["audit_events"]);
  });
});
