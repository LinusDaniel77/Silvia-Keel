import { randomBytes } from "node:crypto";
import { openPglite, openPostgres, type Db } from "./db.ts";

/**
 * A fresh, empty database for one test file. In-process PGlite by default; with
 * SHIELD_TEST_DATABASE_URL set, a throwaway schema on that real Postgres server (dropped on
 * close), so the same tests prove the production path. CI runs both.
 */
export async function openTestDb(): Promise<Db> {
  const url = process.env.SHIELD_TEST_DATABASE_URL;
  if (!url) return openPglite();
  const schema = `shield_test_${randomBytes(6).toString("hex")}`;
  const db = openPostgres(url, { schema });
  await db.query(`CREATE SCHEMA ${schema}`);
  return {
    ...db,
    close: async () => {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.close();
    },
  };
}
