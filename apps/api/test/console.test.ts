import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApiKey, createTenant, migrate, openTestDb, type Db } from "@shield/db";
import { CorpusItemSchema } from "@shield/eval";
import { loadLibrary } from "@shield/tactics";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";

const SAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../samples");
const BEC = readFileSync(path.join(SAMPLES, "bec-vendor-change.eml"), "utf8");
const LEGIT = readFileSync(path.join(SAMPLES, "legit-urgent-cfo.eml"), "utf8");

let db: Db;
let app: FastifyInstance;
let keyA = "";
let keyB = "";

type Json = Record<string, unknown>;
const call = async (
  method: "GET" | "POST" | "PUT",
  url: string,
  body?: unknown,
  key = keyA,
  actor = "reviewer-1",
) => {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${key}`, "x-shield-actor": actor },
    ...(body !== undefined ? { payload: body as Json } : {}),
  });
  return { status: res.statusCode, body: res.json() as unknown, raw: res.body };
};

/** A shadow-mode payment check whose only message is `email` with its invoice ids rewritten. */
async function payment(email: string, inv: string) {
  const r = await call("POST", "/v1/approvals/check", {
    action: { kind: "payment", amount: 1000, currency: "USD" },
    objectIds: [inv],
    subject: { type: "role", id: "cfo" },
    artifacts: [{ rawEmail: email.replace(/INV-\d+/g, inv) + `\n${inv}` }],
  });
  return r.body as Json;
}

beforeAll(async () => {
  db = await openTestDb();
  await migrate(db);
  keyA = await createApiKey(
    db,
    await createTenant(db, { name: "A", orgDomains: ["keelbridge.com"] }),
  );
  keyB = await createApiKey(db, await createTenant(db, { name: "B" }));
  app = buildApp({ db, library: loadLibrary() });

  // Three paused requests reviewed as attack, attack, legitimate, plus one unpaused legitimate one.
  const bec = BEC.replace("Updated remittance", "Payment needed").concat(
    "\nKeep this between us. Skip the normal approval this once.",
  );
  const ids = [];
  for (const inv of ["INV-1001", "INV-1002", "INV-1003"])
    ids.push((await payment(bec, inv)).requestId as string);
  const calm = (await payment(LEGIT, "INV-2001")).requestId as string;
  await call("POST", `/v1/requests/${ids[0]}/review`, { outcome: "attack" });
  await call("POST", `/v1/requests/${ids[1]}/review`, { outcome: "attack" });
  await call("POST", `/v1/requests/${ids[2]}/review`, { outcome: "legitimate" });
  await call("POST", `/v1/requests/${calm}/review`, { outcome: "legitimate" });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe("console reports", () => {
  it("computes shadow-mode precision and false-alarm rate from reviews", async () => {
    const s = (await call("GET", "/v1/reports/summary?days=30")).body as unknown as {
      workflows: {
        actionKind: string;
        mode: string;
        decisions: Record<string, number>;
        wouldHold: number;
        pausePrecision: Json;
        falseAlarmRate: Json;
      }[];
      totals: Json;
      catches: Json[];
    };
    const p = s.workflows.find((w) => w.actionKind === "payment")!;
    expect(p.mode).toBe("shadow");
    expect(p.decisions.PAUSE).toBe(3);
    expect(p.wouldHold).toBe(3);
    expect(p.pausePrecision).toMatchObject({ num: 2, den: 3 });
    expect((p.pausePrecision.ci as number[]).length).toBe(2);
    expect(p.falseAlarmRate).toMatchObject({ num: 1, den: 2 });
    expect(s.totals).toMatchObject({
      checks: 4,
      paused: 3,
      confirmedAttacks: 2,
      stoppedAttacks: 0,
    });
    expect(s.catches).toHaveLength(2);
    expect(s.catches[0]).toMatchObject({ decision: "PAUSE", stopped: false });
  });

  it("lists requests newest first with filters and paging", async () => {
    const all = (await call("GET", "/v1/requests")).body as unknown as Json[];
    expect(all).toHaveLength(4);
    const paused = (await call("GET", "/v1/requests?decision=PAUSE")).body as unknown as Json[];
    expect(paused).toHaveLength(3);
    const page1 = (await call("GET", "/v1/requests?limit=2")).body as unknown as Json[];
    const page2 = (
      await call(
        "GET",
        `/v1/requests?limit=2&before=${encodeURIComponent(page1[1]!.createdAt as string)}`,
      )
    ).body as unknown as Json[];
    expect(page2.length).toBeGreaterThan(0);
    expect(page2.map((r) => r.id)).not.toContain(page1[0]!.id);
    expect((await call("GET", "/v1/requests?decision=MAYBE")).status).toBe(400);
  });

  it("never returns a person reference outside the audit trail", async () => {
    const summary = (await call("GET", "/v1/reports/summary")).raw;
    const list = (await call("GET", "/v1/requests")).raw;
    for (const body of [summary, list]) {
      expect(body).not.toContain("actor_ref");
      expect(body).not.toContain("reviewer-1");
    }
    const id = ((await call("GET", "/v1/requests")).body as unknown as Json[])[0]!.id as string;
    const detail = (await call("GET", `/v1/requests/${id}`)).body as unknown as {
      auditEvents: Json[];
    };
    expect(detail.auditEvents[0]).toMatchObject({
      actor_ref: "reviewer-1",
      event: expect.stringMatching(/^review_/),
    });
  });

  it("reviews feed the label export and need an actor", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/labels/export",
      headers: { authorization: `Bearer ${keyA}` },
    });
    const items = res.body
      .trim()
      .split("\n")
      .map((l) => CorpusItemSchema.parse(JSON.parse(l)));
    expect(items.filter((i) => i.labels.attack)).toHaveLength(2);
    const id = ((await call("GET", "/v1/requests")).body as unknown as Json[])[0]!.id as string;
    const noActor = await app.inject({
      method: "POST",
      url: `/v1/requests/${id}/review`,
      headers: { authorization: `Bearer ${keyA}` },
      payload: { outcome: "attack" },
    });
    expect(noActor.statusCode).toBe(400);
  });

  it("keeps reports per tenant", async () => {
    const s = (await call("GET", "/v1/reports/summary", undefined, keyB)).body as unknown as {
      totals: Json;
    };
    expect(s.totals.checks).toBe(0);
    expect((await call("GET", "/v1/requests", undefined, keyB)).body).toEqual([]);
  });

  it("serves the console with a strict CSP and no inline styles or scripts", async () => {
    for (const url of ["/console", "/console/app.js", "/console/styles.css"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    }
    const html = (await app.inject({ method: "GET", url: "/console" })).body;
    const js = (await app.inject({ method: "GET", url: "/console/app.js" })).body;
    expect(html).not.toMatch(/<script>|style="/);
    expect(js).not.toMatch(/style="/);
    expect((await app.inject({ method: "GET", url: "/console/../package.json" })).statusCode).toBe(
      404,
    );
  });
});
