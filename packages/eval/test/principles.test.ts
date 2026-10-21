/**
 * The roadmap's principles, enforced as tests. See docs/principles.md for the mapping.
 */
import { analyze } from "@shield/engine";
import { ScriptedProvider } from "@shield/llm";
import * as shared from "@shield/shared";
import { DECISION_RANK } from "@shield/shared";
import { findPersonLabels, loadLibrary } from "@shield/tactics";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadCorpus } from "../src/index.ts";

const library = loadLibrary();
const corpus = loadCorpus();

function keysOf(schema: z.ZodTypeAny, prefix = ""): string[] {
  let s: z.ZodTypeAny = schema;
  while (
    s instanceof z.ZodDefault ||
    s instanceof z.ZodOptional ||
    s instanceof z.ZodNullable ||
    s instanceof z.ZodEffects
  )
    s = s instanceof z.ZodEffects ? s.innerType() : (s._def.innerType as z.ZodTypeAny);
  if (s instanceof z.ZodArray) return keysOf(s.element, prefix);
  if (s instanceof z.ZodObject)
    return Object.entries(s.shape as Record<string, z.ZodTypeAny>).flatMap(([k, v]) => [
      `${prefix}${k}`,
      ...keysOf(v, `${prefix}${k}.`),
    ]);
  return [];
}

describe("principle 2: analyze requests, not employees", () => {
  it("no domain schema carries recipient identity or a per-person score", () => {
    const schemas = Object.entries(shared).filter(
      ([name, v]) => name.endsWith("Schema") && v instanceof z.ZodType,
    );
    expect(schemas.length).toBeGreaterThan(5);
    // The walker must actually reach nested fields for this test to mean anything.
    expect(keysOf(shared.ShieldRequestSchema)).toContain("artifacts.sender.address");
    const forbidden =
      /(^|\.)(to|cc|bcc|recipients?|employee\w*|user\w*|person\w*|riskScore|\w*RiskScore)$/i;
    for (const [name, schema] of schemas) {
      const offending = keysOf(schema as z.ZodTypeAny).filter((k) => forbidden.test(k));
      expect(offending, `${name} must not model people`).toEqual([]);
    }
  });
});

describe("principles 3 and 5: label the tactic, explain every flag", () => {
  it("every fired tactic gets an explanation with evidence, and none labels a person", async () => {
    for (const item of corpus) {
      const a = await analyze(item.request, { library });
      const fired = a.hits.filter((h) => h.confidence >= library.manifest.fire_threshold);
      expect(a.explanations).toHaveLength(fired.length);
      for (const h of fired)
        expect(h.evidence.length, `${item.id} ${h.tacticId}`).toBeGreaterThan(0);
      for (const e of a.explanations) expect(findPersonLabels(e), `${item.id}: ${e}`).toEqual([]);
      if (a.decision !== "ALLOW") expect(a.explanations.length, item.id).toBeGreaterThan(0);
    }
  });
});

describe("principle 4: precision first", () => {
  it("never pauses a request with no high-risk action", async () => {
    for (const item of corpus) {
      const a = await analyze(item.request, { library });
      if (!a.highRiskAction) expect(a.decision, item.id).not.toBe("PAUSE");
    }
  });
});

describe("prompt injection", () => {
  const pairs = corpus.filter((i) => i.pairOf);

  it("the corpus carries injected/clean pairs", () =>
    expect(pairs.length).toBeGreaterThanOrEqual(20));

  it("injected text never lowers the verdict, even when it fully compromises the model", async () => {
    // Worst case: a model the injection has fully talked into reporting nothing.
    const compromised = new ScriptedProvider(() => []);
    const byId = new Map(corpus.map((i) => [i.id, i]));
    for (const item of pairs) {
      const base = byId.get(item.pairOf!)!;
      const clean = await analyze(base.request, { library });
      const injected = await analyze(item.request, { library, provider: compromised });
      expect(DECISION_RANK[injected.decision], item.id).toBeGreaterThanOrEqual(
        DECISION_RANK[clean.decision],
      );
    }
  });
});
