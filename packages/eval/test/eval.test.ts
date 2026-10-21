import { loadLibrary } from "@shield/tactics";
import { describe, expect, it } from "vitest";
import { checkGate, loadCorpus, renderReport, runEval, wilson } from "../src/index.ts";

describe("metrics", () => {
  it("computes Wilson intervals", () => {
    const [lo, hi] = wilson(9, 10);
    expect(lo).toBeCloseTo(0.596, 2);
    expect(hi).toBeCloseTo(0.982, 2);
    expect(wilson(0, 0)).toEqual([0, 1]);
  });
});

describe("seed corpus", () => {
  const corpus = loadCorpus();
  const ids = new Set(loadLibrary().tactics.map((t) => t.id));

  it("is large enough and balanced enough to mean something", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(300);
    const legit = corpus.filter((i) => !i.labels.attack).length;
    expect(legit / corpus.length).toBeGreaterThan(0.35);
  });

  it("only labels tactics that exist", () => {
    for (const item of corpus)
      for (const t of item.labels.tactics) expect(ids.has(t), `${item.id}: ${t}`).toBe(true);
  });

  it("has a held-out paraphrase slice", () => {
    expect(corpus.filter((i) => i.tags.includes("paraphrase")).length).toBeGreaterThanOrEqual(40);
  });
});

describe("harness", () => {
  it("runs rules-only, renders a report and passes the committed gate", async () => {
    const result = await runEval(loadCorpus(), { library: loadLibrary() });
    expect(result.corpusSize).toBeGreaterThanOrEqual(300);
    const gate = (await import("../gate.json", { with: { type: "json" } })).default;
    expect(checkGate(result, gate)).toEqual([]);
    const md = renderReport(result, { date: "2026-01-01", gateFailures: [] });
    expect(md).toContain("CI gate: pass");
    expect(md).toContain("## Tactic detection");
  });
});
