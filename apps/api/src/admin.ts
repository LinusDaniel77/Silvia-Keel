import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  createApiKey,
  createTenant,
  migrate,
  openPostgres,
  revokeOtherKeys,
  withTenant,
} from "@shield/db";
import { z } from "zod";
import { parseCsv } from "./csv.ts";
import { upsertContacts } from "./service.ts";

const USAGE = `Manipulation Shield admin (needs DATABASE_URL)

  pnpm admin create-tenant --name <name> [--org-domain <domain>]... [--retention-days <n>]
  pnpm admin rotate-key --tenant <id>
  pnpm admin import-contacts --tenant <id> --source <system name> <contacts.csv>

contacts.csv needs a header row: subject_type,subject_id,channel,value
  subject_type: vendor | role     channel: phone | email
  e.g. vendor,V-ATLAS-01,phone,+1 206 555 0100

Keys are printed once and stored only as SHA-256 hashes.`;

const ContactRow = z.object({
  subjectType: z.enum(["vendor", "role"]),
  subjectId: z.string().min(1),
  channel: z.enum(["phone", "email"]),
  value: z.string().min(3),
});

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      "org-domain": { type: "string", multiple: true },
      "retention-days": { type: "string" },
      tenant: { type: "string" },
      source: { type: "string" },
    },
  });
  if (!cmd || !["create-tenant", "rotate-key", "import-contacts"].includes(cmd)) {
    console.log(USAGE);
    return cmd ? 2 : 0;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const db = openPostgres(url);
  try {
    await migrate(db);
    if (cmd === "create-tenant") {
      if (!values.name) throw new Error("--name is required");
      const tenantId = await createTenant(db, {
        name: values.name,
        orgDomains: values["org-domain"] ?? [],
        retentionDays: values["retention-days"] ? Number(values["retention-days"]) : undefined,
      });
      const key = await createApiKey(db, tenantId, "created by admin");
      console.log(`tenant: ${tenantId}\napi key (shown once): ${key}`);
    } else if (cmd === "rotate-key") {
      const tenantId = z.string().uuid().parse(values.tenant);
      const key = await createApiKey(db, tenantId, "rotated by admin");
      const revoked = await revokeOtherKeys(db, tenantId, key);
      console.log(`new api key (shown once): ${key}\nrevoked ${revoked} older key(s)`);
    } else {
      const tenantId = z.string().uuid().parse(values.tenant);
      if (!values.source || !positionals[0])
        throw new Error("--source and a CSV file are required");
      const [header, ...rows] = parseCsv(readFileSync(positionals[0], "utf8"));
      const cols = (header ?? []).map((h) => h.trim().toLowerCase());
      const idx = (name: string) => {
        const i = cols.indexOf(name);
        if (i < 0) throw new Error(`CSV is missing the "${name}" column`);
        return i;
      };
      const [t, id, ch, v] = ["subject_type", "subject_id", "channel", "value"].map(idx) as [
        number,
        number,
        number,
        number,
      ];
      const contacts = rows.map((r, n) => {
        const parsed = ContactRow.safeParse({
          subjectType: r[t]?.trim().toLowerCase(),
          subjectId: r[id]?.trim(),
          channel: r[ch]?.trim().toLowerCase(),
          value: r[v]?.trim(),
        });
        if (!parsed.success) throw new Error(`row ${n + 2}: ${parsed.error.issues[0]?.message}`);
        return parsed.data;
      });
      const out = await withTenant(db, tenantId, (tx) =>
        upsertContacts(tx, tenantId, values.source!, contacts),
      );
      console.log(`imported ${out.upserted} contact(s) from ${values.source}`);
    }
    return 0;
  } finally {
    await db.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
