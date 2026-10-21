import { parseArgs } from "node:util";
import {
  createApiKey,
  createTenant,
  migrate,
  openPglite,
  openPostgres,
  purgeBodies,
  withTenant,
  type Db,
} from "@shield/db";
import { AnthropicProvider, hasAnthropicCredentials } from "@shield/llm";
import { loadLibrary } from "@shield/tactics";
import { buildApp } from "./app.ts";
import { upsertContacts } from "./service.ts";

/**
 * Local server. With DATABASE_URL it uses that Postgres; otherwise an in-memory Postgres (PGlite)
 * seeded with a demo tenant, whose API key is printed once.
 *
 * The LLM is off unless SHIELD_LLM=on and credentials exist: every classifier call costs money.
 */
async function main() {
  const { values } = parseArgs({ options: { port: { type: "string" }, host: { type: "string" } } });
  const db: Db = process.env.DATABASE_URL
    ? openPostgres(process.env.DATABASE_URL)
    : await openPglite();
  await migrate(db);

  if (!process.env.DATABASE_URL) {
    const tenantId = await createTenant(db, {
      name: "Demo (Keelbridge)",
      orgDomains: ["keelbridge.com"],
    });
    const key = await createApiKey(db, tenantId, "local demo");
    await withTenant(db, tenantId, (tx) =>
      upsertContacts(tx, tenantId, "vendor master (demo)", [
        {
          subjectType: "vendor",
          subjectId: "V-ATLAS-01",
          channel: "phone",
          value: "+1 206 555 0100",
        },
        {
          subjectType: "vendor",
          subjectId: "V-ATLAS-01",
          channel: "email",
          value: "ap@atlasfreight.com",
        },
      ]),
    );
    console.log(`In-memory database with a demo tenant. API key (shown once): ${key}`);
  }

  const llmOn = process.env.SHIELD_LLM === "on" && hasAnthropicCredentials();
  const app = buildApp({
    db,
    library: loadLibrary(),
    ...(llmOn ? { provider: new AnthropicProvider() } : {}),
  });

  // Retention: purge expired bodies at start and hourly.
  const purge = () =>
    purgeBodies(db).catch((e: Error) => console.error(`retention purge failed: ${e.name}`));
  await purge();
  const timer = setInterval(purge, 3_600_000);
  app.addHook("onClose", async () => clearInterval(timer));

  const host = values.host ?? "127.0.0.1";
  const port = Number(values.port ?? 4180);
  await app.listen({ host, port });
  console.log(
    `Manipulation Shield API on http://${host}:${port} (LLM ${llmOn ? "on" : "off: rules only"})`,
  );
}

void main();
