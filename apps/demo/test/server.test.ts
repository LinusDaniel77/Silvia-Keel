import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLibrary } from "@shield/tactics";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDemoServer, MAX_BODY_BYTES } from "../src/server.ts";

const SAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../samples");
const server = createDemoServer({ library: loadLibrary() });
let base = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const post = (body: unknown) =>
  fetch(`${base}/api/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("demo server", () => {
  it("serves the page with a strict CSP and reports rules-only mode", async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    const config = (await (await fetch(`${base}/api/config`)).json()) as {
      claudeAvailable: boolean;
      samples: unknown[];
    };
    expect(config.claudeAvailable).toBe(false);
    expect(config.samples).toHaveLength(4);
  });

  it("pauses the vendor bank-change attack pasted as a raw email", async () => {
    const res = await post({
      text: readFileSync(path.join(SAMPLES, "bec-vendor-change.eml"), "utf8"),
      action: "vendor_bank_change",
      orgDomain: "keelbridge.com",
      knownDomain: "atlasfreight.com",
      useClaude: true,
    });
    const data = (await res.json()) as {
      analysis: { decision: string };
      artifacts: { replyTo?: string }[];
      claudeUsed: boolean;
    };
    expect(data.analysis.decision).toBe("PAUSE");
    expect(data.artifacts[0]!.replyTo).toBe("atlas.accounts.receivable@gmail.com");
    expect(data.claudeUsed).toBe(false);
  });

  it("does not pause the real CFO's urgent request", async () => {
    const res = await post({
      text: readFileSync(path.join(SAMPLES, "legit-urgent-cfo.eml"), "utf8"),
      action: "payment",
      orgDomain: "keelbridge.com",
    });
    expect(((await res.json()) as { analysis: { decision: string } }).analysis.decision).not.toBe(
      "PAUSE",
    );
  });

  it("accepts a full request JSON and plain text", async () => {
    const json = await post({
      text: readFileSync(path.join(SAMPLES, "multi-channel.json"), "utf8"),
    });
    expect(((await json.json()) as { artifacts: unknown[] }).artifacts).toHaveLength(2);
    const plain = await post({
      text: "Skip the normal approval this once and keep this between us.",
      action: "payment",
    });
    expect(((await plain.json()) as { analysis: { decision: string } }).analysis.decision).toBe(
      "PAUSE",
    );
  });

  it("rejects bad input cleanly", async () => {
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ text: "" })).status).toBe(400);
    expect((await post({ text: "x".repeat(MAX_BODY_BYTES + 10) })).status).toBe(413);
    expect((await fetch(`${base}/../package.json`)).status).toBe(404);
  });
});
