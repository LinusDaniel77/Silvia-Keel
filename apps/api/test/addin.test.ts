import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApiKey, createTenant, migrate, openTestDb, type Db } from "@shield/db";
import { parseEml } from "@shield/engine";
import { loadLibrary } from "@shield/tactics";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, renderManifest } from "../src/app.ts";

const SAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../samples");
let db: Db;
let app: FastifyInstance;
let key = "";

beforeAll(async () => {
  db = await openTestDb();
  await migrate(db);
  key = await createApiKey(
    db,
    await createTenant(db, { name: "A", orgDomains: ["keelbridge.com"] }),
  );
  app = buildApp({ db, library: loadLibrary() });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

/** Tag balance for well-formedness: enough to catch a broken template, without an XML dependency. */
function assertWellFormed(xml: string) {
  const stack: string[] = [];
  for (const m of xml
    .replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g, "")
    .matchAll(/<(\/?)([\w:.-]+)[^>]*?(\/?)>/g)) {
    const [, close, name, self] = m;
    if (self) continue;
    if (close) expect(stack.pop(), `closing </${name}>`).toBe(name);
    else stack.push(name!);
  }
  expect(stack).toEqual([]);
}

describe("Outlook add-in", () => {
  it("checks a message without storing anything", async () => {
    const { id: _id, ...artifact } = parseEml(
      readFileSync(path.join(SAMPLES, "bec-vendor-change.eml"), "utf8"),
    );
    const before = (await db.query<{ n: string }>("SELECT count(*) AS n FROM requests")).rows[0]!.n;
    const res = await app.inject({
      method: "POST",
      url: "/v1/check-message",
      headers: { authorization: `Bearer ${key}` },
      payload: { artifact, action: { kind: "vendor_bank_change" } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      decision: string;
      explanations: string[];
      tactics: { evidence: string[] }[];
    };
    expect(body.decision).toBe("PAUSE");
    expect(body.explanations.length).toBeGreaterThan(0);
    expect(body.tactics.flatMap((t) => t.evidence)).toContain("updated banking details");
    const after = (await db.query<{ n: string }>("SELECT count(*) AS n FROM requests")).rows[0]!.n;
    expect(after).toBe(before);
  });

  it("requires the organization key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/check-message",
      payload: { artifact: { channel: "email", body: "x" } },
    });
    expect(res.statusCode).toBe(401);
  });

  it("renders a well-formed manifest for an https origin, and refuses plain http", () => {
    const xml = renderManifest("https://shield.example.com/anything");
    assertWellFormed(xml);
    expect(xml).toContain(
      '<SourceLocation DefaultValue="https://shield.example.com/addin/taskpane.html" />',
    );
    expect(xml).not.toContain("{{BASE}}");
    expect(xml).toContain("<Permissions>ReadItem</Permissions>");
    expect(() => renderManifest("http://shield.example.com")).toThrow(/https/);
    expect(renderManifest("http://localhost:4180")).toContain(
      "http://localhost:4180/addin/icon-64.png",
    );
  });

  it("serves the task pane with Office.js as the only external script", async () => {
    const res = await app.inject({ method: "GET", url: "/addin/taskpane.html" });
    expect(res.statusCode).toBe(200);
    const csp = res.headers["content-security-policy"] as string;
    expect(csp).toContain("script-src 'self' https://appsforoffice.microsoft.com");
    expect(csp).toContain("frame-ancestors");
    expect(res.body).not.toMatch(/style="|<script>/);
    const icon = await app.inject({ method: "GET", url: "/addin/icon-80.png" });
    expect(icon.headers["content-type"]).toBe("image/png");
    expect(icon.rawPayload.subarray(1, 4).toString()).toBe("PNG");
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/addin/manifest.xml",
          headers: { host: "localhost:4180" },
        })
      ).statusCode,
    ).toBe(200);
  });
});
