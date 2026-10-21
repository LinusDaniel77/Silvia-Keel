import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

/** The narrow database surface the app uses, satisfied by both node-postgres and PGlite. */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/** In-process Postgres (WASM). Used by tests and the local dev server; no server needed. */
export async function openPglite(dataDir?: string): Promise<Db> {
  const pgl = new PGlite(dataDir);
  const asDb = (q: Pick<PGlite, "query">, nested: boolean): Db => ({
    query: async <T>(sql: string, params?: unknown[]) => ({
      rows: (await q.query<T>(sql, params)).rows,
    }),
    // PGlite has no nested transactions; inside one, further calls just reuse it.
    transaction: nested
      ? (fn) => fn(asDb(q, true))
      : (fn) => pgl.transaction((tx) => fn(asDb(tx, true))),
    close: nested ? async () => {} : () => pgl.close(),
  });
  return asDb(pgl, false);
}

/** A real Postgres server through node-postgres. */
export function openPostgres(connectionString: string, opts: { schema?: string } = {}): Db {
  if (opts.schema && !/^[a-z_][a-z0-9_]*$/.test(opts.schema))
    throw new Error("invalid schema name");
  const pool = new pg.Pool({
    connectionString,
    ...(opts.schema ? { options: `-c search_path=${opts.schema}` } : {}),
  });
  const wrap = (c: pg.Pool | pg.PoolClient): Pick<Db, "query"> => ({
    query: async <T>(sql: string, params?: unknown[]) => ({
      rows: (await c.query(sql, params)).rows as T[],
    }),
  });
  return {
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      const tx: Db = { ...wrap(client), transaction: (f) => f(tx), close: async () => {} };
      try {
        await client.query("BEGIN");
        const out = await fn(tx);
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Applies migrations/*.sql in order, once each. */
/** Any constant; identifies the migration lock among the database's advisory locks. */
const MIGRATION_LOCK = 7_431_002_611;

/**
 * Applies migrations/*.sql in order, once each, in one transaction. An advisory lock serializes
 * concurrent runs (two API replicas starting together, or parallel test files): roles are
 * cluster-wide, so two unserialized runs race on CREATE ROLE even in different schemas.
 */
export async function migrate(db: Db): Promise<string[]> {
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await tx.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set(
      (await tx.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map(
        (r) => r.name,
      ),
    );
    const applied: string[] = [];
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      if (done.has(file)) continue;
      await execScript(tx, readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
      await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      applied.push(file);
    }
    return applied;
  });
}

/** Runs a multi-statement SQL script (no parameters) through the query interface. */
async function execScript(db: Db, sql: string) {
  for (const statement of splitSql(sql)) await db.query(statement);
}

/** Splits on semicolons outside quotes and $$ blocks, dropping comment-only chunks. */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inDollar = false;
  let inQuote = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (!inQuote && sql.startsWith("$$", i)) {
      inDollar = !inDollar;
      cur += "$$";
      i++;
      continue;
    }
    if (!inDollar && c === "'") inQuote = !inQuote;
    if (!inDollar && !inQuote && c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      cur += "\n";
      continue;
    }
    if (!inDollar && !inQuote && c === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Runs `fn` as the restricted app role with the tenant set, inside a transaction. Row-level
 * security then confines every query to that tenant, whatever the SQL says.
 */
export function withTenant<T>(db: Db, tenantId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("SET LOCAL ROLE shield_app");
    await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    return fn(tx);
  });
}
