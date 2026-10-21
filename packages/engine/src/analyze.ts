import {
  ShieldRequestSchema,
  type Analysis,
  type ShieldRequestInput,
  type TacticHit,
  type Provenance,
} from "@shield/shared";
import { buildPrompt, validateHits, type LlmProvider } from "@shield/llm";
import type { TacticLibrary } from "@shield/tactics";
import { decide, mergeHits } from "./decide.ts";
import { explain } from "./explain.ts";
import { computeFeatures } from "./features.ts";
import { analysisText } from "./normalize.ts";
import { detectIntents, isHighRisk } from "./prefilter.ts";
import { ruleHits } from "./rules.ts";

export const ENGINE_VERSION = "0.1.0";

export interface AnalyzeOptions {
  library: TacticLibrary;
  /** Omit for rules-only mode (offline, deterministic). */
  provider?: LlmProvider;
}

/** Everything that runs before the LLM: deterministic, free, and identical in every mode. */
export function prepare(input: ShieldRequestInput, library: TacticLibrary) {
  const request = ShieldRequestSchema.parse(input);
  const text = analysisText(request.artifacts);
  const intents = detectIntents(text);
  const highRisk = isHighRisk(request, intents);
  const features = computeFeatures(request);
  const rules = ruleHits(library, text, features);
  /** The LLM is only asked about high-risk requests or ones the rules already flag. */
  const needsLlm = highRisk || rules.some((h) => h.confidence >= library.manifest.fire_threshold);
  return { request, text, intents, highRisk, features, rules, needsLlm };
}

/** The exact prompt the classifier would receive, or null when the prefilter skips the LLM. */
export function promptFor(input: ShieldRequestInput, library: TacticLibrary, model: string) {
  const p = prepare(input, library);
  return p.needsLlm ? buildPrompt(library, p.request, model) : null;
}

/**
 * normalize -> prefilter -> features -> rules (+ LLM) -> merge -> decide -> explain.
 * Every analysis records the library version, model and prompt hash that produced it.
 */
export async function analyze(input: ShieldRequestInput, opts: AnalyzeOptions): Promise<Analysis> {
  const { library, provider } = opts;
  const { request, text, intents, highRisk, features, rules, needsLlm } = prepare(input, library);

  let llmHits: TacticHit[] = [];
  let llmStatus: Provenance["llmStatus"] = "not_called";
  let promptHash: string | null = null;
  if (provider) {
    if (!needsLlm) {
      llmStatus = "skipped_prefilter";
    } else {
      const prompt = buildPrompt(library, request, provider.model ?? provider.id);
      promptHash = prompt.hash;
      const result = await provider.classify(prompt);
      llmStatus = result.status;
      if (result.status === "ok") llmHits = validateHits(result.hits, library, text).hits;
    }
  }

  const hits = mergeHits(rules, llmHits);
  const d = decide(library, hits, highRisk);

  return {
    requestId: request.id,
    decision: d.decision,
    highRiskAction: highRisk,
    intents,
    hits,
    familiesFired: d.familiesFired,
    criticalCombination: d.criticalCombination,
    explanations: explain(library, d.fired),
    features,
    provenance: {
      engineVersion: ENGINE_VERSION,
      libraryVersion: library.manifest.version,
      provider: provider?.id ?? "none",
      model: provider?.model ?? null,
      promptHash,
      llmStatus,
    },
  };
}
