import { analyze } from "@shield/engine";
import type { LlmProvider } from "@shield/llm";
import { DECISION_RANK, type Analysis, type Decision } from "@shield/shared";
import type { TacticLibrary } from "@shield/tactics";
import type { CorpusItem } from "./corpus.ts";
import { binaryRates, rate, type BinaryCounts, type Rate } from "./metrics.ts";

export interface ItemResult {
  item: CorpusItem;
  analysis: Analysis;
  detected: string[];
}

export interface SliceMetrics {
  name: string;
  attacks: number;
  legit: number;
  pauseRecall: Rate;
  warnOrAboveRecall: Rate;
  pauseFalseAlarmRate: Rate;
}

export interface EvalResult {
  provider: string;
  model: string | null;
  libraryVersion: string;
  corpusSize: number;
  confusion: Record<"attack" | "legit", Record<Decision, number>>;
  pause: ReturnType<typeof binaryRates>;
  warnOrAbove: ReturnType<typeof binaryRates>;
  tactics: { id: string; support: number; precision: Rate; recall: Rate }[];
  slices: SliceMetrics[];
  injectionPairs: { checked: number; violations: string[] };
  llmStatus: Record<string, number>;
  falseAlarms: ItemResult[];
  misses: ItemResult[];
  results: ItemResult[];
}

const counts = (results: ItemResult[], atLeast: Decision): BinaryCounts => {
  const c = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const r of results) {
    const flagged = DECISION_RANK[r.analysis.decision] >= DECISION_RANK[atLeast];
    if (r.item.labels.attack) {
      if (flagged) c.tp++;
      else c.fn++;
    } else if (flagged) c.fp++;
    else c.tn++;
  }
  return c;
};

function slice(name: string, results: ItemResult[]): SliceMetrics {
  const pause = binaryRates(counts(results, "PAUSE"));
  const warn = binaryRates(counts(results, "WARN"));
  return {
    name,
    attacks: results.filter((r) => r.item.labels.attack).length,
    legit: results.filter((r) => !r.item.labels.attack).length,
    pauseRecall: pause.recall,
    warnOrAboveRecall: warn.recall,
    pauseFalseAlarmRate: pause.falseAlarmRate,
  };
}

export async function runEval(
  corpus: CorpusItem[],
  opts: { library: TacticLibrary; provider?: LlmProvider; concurrency?: number },
): Promise<EvalResult> {
  const { library, provider } = opts;
  const results: ItemResult[] = new Array(corpus.length);
  let next = 0;
  const worker = async () => {
    while (next < corpus.length) {
      const i = next++;
      const item = corpus[i]!;
      const analysis = await analyze(item.request, { library, provider });
      const detected = analysis.hits
        .filter((h) => h.confidence >= library.manifest.fire_threshold)
        .map((h) => h.tacticId);
      results[i] = { item, analysis, detected };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));

  const confusion: EvalResult["confusion"] = {
    attack: { ALLOW: 0, WARN: 0, PAUSE: 0 },
    legit: { ALLOW: 0, WARN: 0, PAUSE: 0 },
  };
  const llmStatus: Record<string, number> = {};
  for (const r of results) {
    confusion[r.item.labels.attack ? "attack" : "legit"][r.analysis.decision]++;
    llmStatus[r.analysis.provenance.llmStatus] =
      (llmStatus[r.analysis.provenance.llmStatus] ?? 0) + 1;
  }

  const tactics = library.tactics.map((t) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const r of results) {
      const labeled = r.item.labels.tactics.includes(t.id);
      const hit = r.detected.includes(t.id);
      if (labeled && hit) tp++;
      else if (hit) fp++;
      else if (labeled) fn++;
    }
    return { id: t.id, support: tp + fn, precision: rate(tp, tp + fp), recall: rate(tp, tp + fn) };
  });

  const tagNames = [...new Set(results.flatMap((r) => r.item.tags))].sort();
  const slices = [
    slice("all", results),
    ...["synthetic", "public", "partner", "redteam"]
      .filter((s) => results.some((r) => r.item.source === s))
      .map((s) =>
        slice(
          `source:${s}`,
          results.filter((r) => r.item.source === s),
        ),
      ),
    ...tagNames.map((t) =>
      slice(
        `tag:${t}`,
        results.filter((r) => r.item.tags.includes(t)),
      ),
    ),
  ];

  // Injected text must never lower the verdict relative to the same request without it.
  const byId = new Map(results.map((r) => [r.item.id, r]));
  const violations: string[] = [];
  let checked = 0;
  for (const r of results) {
    if (!r.item.pairOf) continue;
    const base = byId.get(r.item.pairOf);
    if (!base) continue;
    checked++;
    if (DECISION_RANK[r.analysis.decision] < DECISION_RANK[base.analysis.decision])
      violations.push(
        `${r.item.id}: ${r.analysis.decision} < ${base.analysis.decision} without injection`,
      );
  }

  return {
    provider: provider?.id ?? "none",
    model: provider?.model ?? null,
    libraryVersion: library.manifest.version,
    corpusSize: corpus.length,
    confusion,
    pause: binaryRates(counts(results, "PAUSE")),
    warnOrAbove: binaryRates(counts(results, "WARN")),
    tactics,
    slices,
    injectionPairs: { checked, violations },
    llmStatus,
    falseAlarms: results.filter((r) => !r.item.labels.attack && r.analysis.decision === "PAUSE"),
    misses: results.filter((r) => r.item.labels.attack && r.analysis.decision !== "PAUSE"),
    results,
  };
}

export interface Gate {
  minPausePrecision: number;
  maxPauseFalseAlarmRate: number;
  minPauseRecall: number;
}

/** Regression gate for CI. Thresholds live in eval/gate.json and only ever move up. */
export function checkGate(result: EvalResult, gate: Gate): string[] {
  const failures: string[] = [];
  const { precision, recall, falseAlarmRate } = result.pause;
  if ((precision.value ?? 0) < gate.minPausePrecision)
    failures.push(`PAUSE precision ${fmt(precision.value)} < ${gate.minPausePrecision}`);
  if ((falseAlarmRate.value ?? 1) > gate.maxPauseFalseAlarmRate)
    failures.push(
      `PAUSE false-alarm rate ${fmt(falseAlarmRate.value)} > ${gate.maxPauseFalseAlarmRate}`,
    );
  if ((recall.value ?? 0) < gate.minPauseRecall)
    failures.push(`PAUSE recall ${fmt(recall.value)} < ${gate.minPauseRecall}`);
  if (result.injectionPairs.violations.length > 0)
    failures.push(`injection lowered the verdict: ${result.injectionPairs.violations.join("; ")}`);
  return failures;
}

const fmt = (v: number | null) => (v === null ? "n/a" : v.toFixed(3));
