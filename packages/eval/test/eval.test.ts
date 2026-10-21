import { loadLibrary } from "@shield/tactics";
import { describe, expect, it } from "vitest";
import {
  checkGate,
  estimateRun,
  loadCorpus,
  renderReport,
  runEval,
  selectByTags,
  wilson,
} from "../src/index.ts";

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

describe("paid-run controls", () => {
  const corpus = loadCorpus();
  const library = loadLibrary();

  it("selects by tag and brings the clean twin of every injection item", () => {
    const picked = selectByTags(corpus, ["injection"]);
    const ids = new Set(picked.map((i) => i.id));
    const injected = picked.filter((i) => i.pairOf);
    expect(injected.length).toBeGreaterThanOrEqual(20);
    for (const i of injected) expect(ids.has(i.pairOf!)).toBe(true);
    expect(
      picked.every((i) => i.tags.includes("injection") || injected.some((x) => x.pairOf === i.id)),
    ).toBe(true);
  });

  it("estimates a run offline, and batches cost about half", () => {
    const subset = selectByTags(corpus, ["paraphrase", "hard", "injection", "handwritten"]);
    const sync = estimateRun(subset, library, "claude-haiku-5-5");
    const batch = estimateRun(subset, library, "claude-haiku-5-5", { batch: true });
    expect(sync.llmCalls).toBeGreaterThan(50);
    expect(sync.llmCalls).toBeLessThanOrEqual(subset.length);
    expect(batch.usd).toBeLessThan(1);
    expect(estimateRun(corpus, library, "claude-opus-5-5").usd).toBeGreaterThan(batch.usd);
  });
});
