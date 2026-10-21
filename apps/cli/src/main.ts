#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { analyze, parseEml, promptFor } from "@shield/engine";
import {
  checkGate,
  DEFAULT_CORPUS,
  estimateRun,
  loadCorpus,
  renderReport,
  runEval,
  selectByTags,
  type ApiUsageSummary,
  type Gate,
} from "@shield/eval";
import {
  AnthropicProvider,
  BudgetedProvider,
  classifyInBatch,
  createAnthropicClient,
  DEFAULT_ANTHROPIC_MODEL,
  estimateCostUsd,
  hasAnthropicCredentials,
  PrecomputedProvider,
  type LlmProvider,
} from "@shield/llm";
import { z } from "zod";
import { ActionKindSchema, type Analysis, type ShieldRequestInput } from "@shield/shared";
import { lintLibrary, loadLibrary, writeLock } from "@shield/tactics";

const EffortSchema = z.enum(["low", "medium", "high"]);

const GATE_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/eval/gate.json",
);

const USAGE = `Manipulation Shield CLI

  shield analyze <file.eml|file.txt|file.json> [--provider none|anthropic] [--action <kind>]
                 [--amount <n>] [--org-domain <d>]... [--known-domain <d>]... [--json]
  shield eval    [--provider none|anthropic] [--corpus <file.jsonl>] [--tags a,b] [--out <report.md>]
                 [--limit <n>] [--concurrency <n>] [--gate]
                 paid runs only: [--model <id>] [--effort low|medium|high] [--estimate]
                                 [--max-usd <n>] [--batch]
  shield tactics lint
  shield tactics lock

--provider none (default) runs the deterministic rules only, offline.
--provider anthropic adds the Claude tactic classifier (needs Anthropic credentials;
  model from --model or SHIELD_MODEL, default claude-opus-5-5; effort defaults to low).
--estimate prints the call count and cost estimate and makes no API call.
--max-usd caps spend: synchronous runs stop calling once the cap would be crossed; batch runs
  refuse to submit if the estimate exceeds it. --batch uses the Batch API at half price.
--tags runs only items with those tags (injection items bring their clean twin).`;

function providerFrom(name: string | undefined): LlmProvider | undefined {
  if (!name || name === "none") return undefined;
  if (name === "anthropic") return new AnthropicProvider();
  throw new Error(`unknown provider "${name}" (expected none or anthropic)`);
}

function requestFromFile(file: string, values: Record<string, unknown>): ShieldRequestInput {
  const raw = readFileSync(file, "utf8");
  const ext = path.extname(file).toLowerCase();
  if (ext === ".json") return JSON.parse(raw) as ShieldRequestInput;
  const artifact =
    ext === ".eml"
      ? parseEml(raw, path.basename(file))
      : { id: path.basename(file), channel: "other" as const, body: raw };
  const kind = values.action ? ActionKindSchema.parse(values.action) : "none";
  return {
    id: path.basename(file),
    action: { kind, ...(values.amount ? { amount: Number(values.amount) } : {}) },
    artifacts: [artifact],
    context: {
      orgDomains: (values["org-domain"] as string[] | undefined) ?? [],
      knownSenderDomains: (values["known-domain"] as string[] | undefined) ?? [],
    },
  };
}

function printAnalysis(a: Analysis) {
  const badge = { ALLOW: "ALLOW", WARN: "WARN ", PAUSE: "PAUSE" }[a.decision];
  console.log(`${badge}  ${a.requestId}`);
  console.log(
    `       high-risk action: ${a.highRiskAction ? "yes" : "no"}${a.intents.length ? ` (intents: ${a.intents.join(", ")})` : ""}`,
  );
  if (a.criticalCombination) console.log(`       critical combination: ${a.criticalCombination}`);
  if (a.explanations.length) {
    console.log("");
    for (const e of a.explanations) console.log(`  - ${e}`);
  }
  if (a.hits.length) {
    console.log("\n  tactic                                 conf  source  evidence");
    for (const h of a.hits)
      console.log(
        `  ${h.tacticId.padEnd(38)} ${h.confidence.toFixed(2)}  ${h.source.padEnd(6)}  ${h.evidence.map((e) => JSON.stringify(e)).join(", ")}`,
      );
  }
  const p = a.provenance;
  console.log(
    `\n  library ${p.libraryVersion} · engine ${p.engineVersion} · provider ${p.provider}${p.model ? ` (${p.model})` : ""} · llm ${p.llmStatus}${p.promptHash ? ` · prompt ${p.promptHash}` : ""}`,
  );
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return 0;
  }

  if (cmd === "tactics") {
    const sub = rest[0];
    if (sub === "lint") {
      const report = lintLibrary();
      for (const w of report.warnings) console.log(`warn   ${w}`);
      for (const e of report.errors) console.log(`error  ${e}`);
      console.log(
        `\n${report.stats.active} active tactics across ${Object.keys(report.stats.families).length} families: ${Object.entries(
          report.stats.families,
        )
          .map(([f, n]) => `${f} ${n}`)
          .join(", ")}`,
      );
      console.log(report.errors.length ? `${report.errors.length} error(s)` : "tactic library OK");
      return report.errors.length ? 1 : 0;
    }
    if (sub === "lock") {
      const lock = writeLock();
      console.log(
        `locked library ${lock.libraryVersion} (${Object.keys(lock.tactics).length} tactics)`,
      );
      return 0;
    }
    console.error(USAGE);
    return 2;
  }

  if (cmd === "analyze") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        provider: { type: "string" },
        action: { type: "string" },
        amount: { type: "string" },
        "org-domain": { type: "string", multiple: true },
        "known-domain": { type: "string", multiple: true },
        json: { type: "boolean" },
      },
    });
    const file = positionals[0];
    if (!file) {
      console.error(USAGE);
      return 2;
    }
    const analysis = await analyze(requestFromFile(file, values), {
      library: loadLibrary(),
      provider: providerFrom(values.provider),
    });
    if (values.json) console.log(JSON.stringify(analysis, null, 2));
    else printAnalysis(analysis);
    return 0;
  }

  if (cmd === "eval") {
    const { values } = parseArgs({
      args: rest,
      options: {
        provider: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        corpus: { type: "string" },
        tags: { type: "string" },
        out: { type: "string" },
        limit: { type: "string" },
        concurrency: { type: "string" },
        estimate: { type: "boolean" },
        "max-usd": { type: "string" },
        batch: { type: "boolean" },
        gate: { type: "boolean" },
      },
    });
    const library = loadLibrary();
    let corpus = loadCorpus(values.corpus ?? DEFAULT_CORPUS);
    if (values.tags)
      corpus = selectByTags(
        corpus,
        values.tags.split(",").map((t) => t.trim()),
      );
    if (values.limit) corpus = corpus.slice(0, Number(values.limit));

    const paid = values.provider === "anthropic";
    if (!paid && (values.estimate || values.batch || values["max-usd"] || values.model))
      throw new Error("--estimate, --batch, --max-usd and --model need --provider anthropic");
    if (values.provider && !["none", "anthropic"].includes(values.provider))
      throw new Error(`unknown provider "${values.provider}" (expected none or anthropic)`);
    const model = values.model ?? process.env.SHIELD_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
    const effort = EffortSchema.parse(values.effort ?? "low");
    const maxUsd = values["max-usd"] !== undefined ? Number(values["max-usd"]) : undefined;
    const batch = Boolean(values.batch);

    if (paid) {
      const est = estimateRun(corpus, library, model, { batch });
      const line = `${est.items} items, ${est.llmCalls} classifier calls on ${model}${batch ? " (batch, half price)" : ""}: estimated $${est.usd.toFixed(4)} (~${est.usage.input + est.usage.cacheRead + est.usage.cacheWrite} input and ~${est.usage.output} output tokens; output allowance is pessimistic)`;
      if (values.estimate) {
        console.log(`Estimate only, no API calls made. ${line}`);
        return 0;
      }
      console.log(line);
      if (!hasAnthropicCredentials())
        throw new Error(
          "no Anthropic credentials (set KEEL_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY; in a cloud session, start a new session after adding it)",
        );
      if (batch && maxUsd !== undefined && est.usd > maxUsd)
        throw new Error(
          `estimated $${est.usd.toFixed(4)} exceeds --max-usd ${maxUsd}; nothing was submitted`,
        );
    }

    let provider: LlmProvider | undefined;
    let budget: BudgetedProvider | undefined;
    let apiUsage: ApiUsageSummary | undefined;
    if (paid && batch) {
      const prompts = corpus.flatMap((i) => promptFor(i.request, library, model) ?? []);
      const run = await classifyInBatch(createAnthropicClient(), prompts, {
        model,
        effort,
        onProgress: (s) => console.log(s),
      });
      provider = new PrecomputedProvider("anthropic-batch", model, run.results);
      apiUsage = {
        model,
        batch: true,
        calls: run.results.size,
        usage: run.usage,
        estimatedUsd: estimateCostUsd(run.usage, model, { batch: true }),
        skippedForBudget: 0,
      };
    } else if (paid) {
      budget = new BudgetedProvider(new AnthropicProvider({ model, effort }), maxUsd ?? Infinity);
      provider = budget;
    }

    const result = await runEval(corpus, {
      library,
      provider,
      concurrency: Number(values.concurrency ?? (provider ? 4 : 1)),
    });
    if (budget)
      apiUsage = {
        model,
        batch: false,
        calls: result.results.filter((r) =>
          ["ok", "refused", "error"].includes(r.analysis.provenance.llmStatus),
        ).length,
        usage: budget.usage,
        estimatedUsd: budget.spentUsd,
        skippedForBudget: budget.skipped,
      };
    const gate: Gate | undefined = values.gate
      ? (JSON.parse(readFileSync(GATE_FILE, "utf8")) as Gate)
      : undefined;
    const failures = gate ? checkGate(result, gate) : undefined;
    const report = renderReport(result, { gateFailures: failures, apiUsage });
    if (values.out) {
      writeFileSync(values.out, report);
      console.log(`report written to ${values.out}`);
    }
    const f = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
    console.log(
      `PAUSE precision ${f(result.pause.precision.value)} · catch rate ${f(result.pause.recall.value)} · false-alarm rate ${f(result.pause.falseAlarmRate.value)} · WARN+ catch rate ${f(result.warnOrAbove.recall.value)} · injection violations ${result.injectionPairs.violations.length}`,
    );
    if (apiUsage)
      console.log(`API: ${apiUsage.calls} calls, estimated $${apiUsage.estimatedUsd.toFixed(4)}`);
    if (failures?.length) {
      for (const x of failures) console.error(`gate: ${x}`);
      return 1;
    }
    return 0;
  }

  console.error(USAGE);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
