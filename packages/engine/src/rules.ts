import type { FeatureResult, TacticHit } from "@shield/shared";
import { matchIndicators, type TacticLibrary } from "@shield/tactics";

export const RULE_CONFIDENCE = {
  single: 0.6,
  multiple: 0.75,
  structural: 0.7,
  weakStructural: 0.45,
  combined: 0.85,
};

/**
 * Features that are common in legitimate traffic (email plus a Teams ping is normal). Alone they
 * stay below the fire threshold; they only count when the wording also matches the tactic.
 */
const WEAK_FEATURES = new Set(["cross_channel_sequence"]);

/**
 * Deterministic tactic hits from lexical, pattern and structural indicators. These run on every
 * request, independently of the LLM, and the LLM cannot remove them.
 */
export function ruleHits(
  library: TacticLibrary,
  text: string,
  features: FeatureResult[],
): TacticHit[] {
  const fired = new Map(features.filter((f) => f.fired).map((f) => [f.id, f]));
  const hits: TacticHit[] = [];
  for (const t of library.tactics) {
    const spans = matchIndicators(t, text);
    const structuralIds = t.indicators.structural.filter((id) => fired.has(id));
    const structural = structuralIds.map((id) => fired.get(id)?.detail ?? id);
    const strong = structuralIds.some((id) => !WEAK_FEATURES.has(id));
    if (spans.length === 0 && structural.length === 0) continue;
    const confidence =
      spans.length > 0 && structural.length > 0
        ? RULE_CONFIDENCE.combined
        : structural.length > 0
          ? strong
            ? RULE_CONFIDENCE.structural
            : RULE_CONFIDENCE.weakStructural
          : spans.length > 1
            ? RULE_CONFIDENCE.multiple
            : RULE_CONFIDENCE.single;
    hits.push({
      tacticId: t.id,
      family: t.family,
      confidence,
      evidence: [...spans, ...structural],
      source: "rules",
    });
  }
  return hits;
}
