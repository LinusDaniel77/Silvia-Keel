import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApiKey, createTenant, migrate, openPglite, type Db } from "@shield/db";
import { CorpusItemSchema } from "@shield/eval";
import { loadLibrary } from "@shield/tactics";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";

const SAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../samples");
const BEC = readFileSync(path.join(SAMPLES, "bec-vendor-change.eml"), "utf8");

let db: Db;
let app: FastifyInstance;
let keyA = "";
let keyB = "";

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  const a = await createTenant(db, { name: "Keelbridge", orgDomains: ["keelbridge.com"] });
  const b = await createTenant(db, { name: "Other" });
  keyA = await createApiKey(db, a);
  keyB = await createApiKey(db, b);
  app = buildApp({ db, library: loadLibrary() });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

type Json = Record<string, unknown>;
const call = async (
  method: "GET" | "POST" | "PUT",
  url: string,
  body?: unknown,
  key = keyA,
  actor?: string,
) => {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${key}`, ...(actor ? { "x-shield-actor": actor } : {}) },
    ...(body !== undefined ? { payload: body as Json } : {}),
  });
  return {
    status: res.statusCode,
    body: res.headers["content-type"]?.includes("application/json")
      ? (res.json() as Json)
      : res.body,
  };
};

const vendorContacts = {
  source: "vendor master (NetSuite)",
  contacts: [
    { subjectType: "vendor", subjectId: "V-ATLAS-01", channel: "phone", value: "+1 206 555 0100" },
    {
      subjectType: "vendor",
      subjectId: "V-ATLAS-01",
      channel: "email",
      value: "ap@atlasfreight.com",
    },
  ],
};
const bankChange = {
  action: { kind: "vendor_bank_change" },
  objectIds: ["V-ATLAS-01", "INV-4471"],
  subject: { type: "vendor", id: "V-ATLAS-01", name: "Atlas Freight" },
};

describe("API", () => {
  it("rejects calls without a valid key", async () => {
    expect((await call("GET", "/v1/labels/export", undefined, "nope")).status).toBe(401);
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });

  it("shadow mode: records the would-be pause but holds nothing", async () => {
    await call("PUT", "/v1/known-contacts", vendorContacts);
    const ingest = await call("POST", "/v1/artifacts", { rawEmail: BEC });
    expect(ingest.status).toBe(201);
    const check = await call("POST", "/v1/approvals/check", bankChange);
    expect(check.body).toMatchObject({
      requestId: (ingest.body as Json).requestId,
      correlatedBy: "object_id_in_text",
      decision: "PAUSE",
      mode: "shadow",
      hold: false,
      wouldHold: true,
      verification: null,
    });
  });

  it("enforce mode: holds, and verifies through the vendor master number, never the message's", async () => {
    expect(
      (await call("PUT", "/v1/workflows/vendor_bank_change", { mode: "enforce" })).status,
    ).toBe(400);
    expect(
      (await call("PUT", "/v1/workflows/vendor_bank_change", { mode: "enforce" }, keyA, "u-17"))
        .status,
    ).toBe(200);

    await call("POST", "/v1/artifacts", {
      rawEmail: BEC.replace("INV-4471", "INV-5001").replace("INV-4490", "INV-5002"),
    });
    const check = await call("POST", "/v1/approvals/check", {
      ...bankChange,
      objectIds: ["V-ATLAS-01", "INV-5001"],
    });
    const body = check.body as Json & { verification: Json & { contact: Json } };
    expect(body).toMatchObject({ decision: "PAUSE", mode: "enforce", hold: true });
    expect(body.verification.status).toBe("pending");
    expect(body.verification.contact).toMatchObject({ channel: "phone", value: "+1 206 555 0100" });
    expect(body.verification.script).toContain("+1 206 555 0100");
    expect(body.verification.script).toContain("Do not use any phone number");
    expect(body.verification.script).not.toContain("gmail.com");

    const vid = body.verification.id as string;
    const done = await call(
      "POST",
      `/v1/verifications/${vid}/complete`,
      { outcome: "attack", channelUsed: "phone" },
      keyA,
      "u-17",
    );
    expect(done.body).toMatchObject({ outcome: "attack", requestStatus: "blocked" });
    expect(
      (
        await call(
          "POST",
          `/v1/verifications/${vid}/complete`,
          { outcome: "legitimate", channelUsed: "phone" },
          keyA,
          "u-17",
        )
      ).status,
    ).toBe(409);

    const detail = await call("GET", `/v1/requests/${body.requestId as string}`);
    expect((detail.body as { request: Json }).request.status).toBe("blocked");

    // The flywheel: the verified attack becomes a valid eval item.
    const exported = await call("GET", "/v1/labels/export");
    const items = (exported.body as string)
      .trim()
      .split("\n")
      .map((l) => CorpusItemSchema.parse(JSON.parse(l)));
    expect(items).toHaveLength(1);
    expect(items[0]!.labels).toMatchObject({ attack: true, tacticsLabeled: false });
  });

  it("asks for a contact instead of inventing one when none is on file", async () => {
    const check = await call("POST", "/v1/approvals/check", {
      ...bankChange,
      objectIds: ["V-NEW-77"],
      subject: { type: "vendor", id: "V-NEW-77" },
      artifacts: [{ rawEmail: BEC.replace(/INV-44\d\d/g, "INV-7777") }],
    });
    const v = (check.body as { verification: Json }).verification;
    expect(v.status).toBe("needs_contact");
    expect(v.contact).toBeNull();
    expect(v.script).toContain("There is no contact on file");
  });

  it("requires a reason to override, and audits it", async () => {
    const check = await call("POST", "/v1/approvals/check", {
      ...bankChange,
      objectIds: ["V-ATLAS-01", "INV-8888"],
      artifacts: [{ rawEmail: BEC.replace(/INV-44\d\d/g, "INV-8888") }],
    });
    const vid = (check.body as { verification: Json }).verification.id as string;
    expect(
      (await call("POST", `/v1/verifications/${vid}/override`, { reason: "ok" }, keyA, "u-2"))
        .status,
    ).toBe(400);
    const ok = await call(
      "POST",
      `/v1/verifications/${vid}/override`,
      { reason: "Confirmed in person with Atlas AR lead" },
      keyA,
      "u-2",
    );
    expect(ok.body).toMatchObject({ requestStatus: "released" });
    const { rows } = await db.query<{ event: string; reason: string; actor_ref: string }>(
      "SELECT event, reason, actor_ref FROM audit_events WHERE verification_id = $1",
      [vid],
    );
    expect(rows).toEqual([
      {
        event: "verification_overridden",
        reason: "Confirmed in person with Atlas AR lead",
        actor_ref: "u-2",
      },
    ]);
  });

  it("keeps tenants apart", async () => {
    const mine = await call("POST", "/v1/artifacts", {
      artifact: { channel: "chat", body: "hello INV-9999" },
    });
    const id = (mine.body as Json).requestId as string;
    expect((await call("GET", `/v1/requests/${id}`)).status).toBe(200);
    expect((await call("GET", `/v1/requests/${id}`, undefined, keyB)).status).toBe(404);
    const theirs = await call(
      "POST",
      "/v1/artifacts",
      { artifact: { channel: "chat", body: "hi INV-9999" } },
      keyB,
    );
    expect((theirs.body as Json).requestId).not.toBe(id);
  });

  it("validates input", async () => {
    expect(
      (await call("POST", "/v1/approvals/check", { ...bankChange, action: { kind: "none" } }))
        .status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/v1/artifacts", {
          rawEmail: BEC,
          artifact: { channel: "chat", body: "x" },
        })
      ).status,
    ).toBe(400);
    expect((await call("GET", "/v1/requests/not-a-uuid")).status).toBe(400);
  });
});
