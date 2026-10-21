import type { Decision, TacticHit } from "@shield/shared";
import type { CriticalCombination, TacticLibrary } from "@shield/tactics";

/**
 * Merges rule and LLM hits per tactic. Agreement between independent sources raises confidence;
 * disagreement never lowers it, so an LLM talked out of a finding cannot veto the rules.
 */
export function mergeHits(rules: TacticHit[], llm: TacticHit[]): TacticHit[] {
  const merged = new Map<string, TacticHit>();
  for (const h of rules) merged.set(h.tacticId, { ...h, evidence: [...h.evidence] });
  for (const h of llm) {
    const prev = merged.get(h.tacticId);
    if (!prev) {
      merged.set(h.tacticId, { ...h, evidence: [...h.evidence] });
      continue;
    }
    merged.set(h.tacticId, {
      ...prev,
      confidence: Math.min(0.95, Math.max(prev.confidence, h.confidence) + 0.1),
      evidence: [...new Set([...prev.evidence, ...h.evidence])],
      source: "both",
    });
  }
  return [...merged.values()].sort(
    (a, b) => b.confidence - a.confidence || a.tacticId.localeCompare(b.tacticId),
  );
}

function satisfied(combo: CriticalCombination, fired: TacticHit[]): boolean {
  return combo.requires.every((req) =>
    req.startsWith("family:")
      ? fired.some((h) => h.family === req.slice(7))
      : fired.some((h) => h.tacticId === req),
  );
}

export interface DecisionResult {
  decision: Decision;
  fired: TacticHit[];
  familiesFired: string[];
  pressureFamilies: string[];
  criticalCombination: string | null;
}

/**
 * The decision policy. Interpretable on purpose: every pause can be explained as either
 * "N independent pressure tactics on a high-risk action" or "critical combination X".
 *
 *   PAUSE  high-risk action AND (>= pause_min_families pressure families OR a critical combination)
 *   WARN   any tactic fired on a high-risk action, or >= pause_min_families families on anything else
 *   ALLOW  otherwise
 */
export function decide(
  library: TacticLibrary,
  hits: TacticHit[],
  highRisk: boolean,
): DecisionResult {
  const { fire_threshold, pause_min_families, non_pressure_families, critical_combinations } =
    library.manifest;
  const fired = hits.filter((h) => h.confidence >= fire_threshold);
  const familiesFired = [...new Set(fired.map((h) => h.family))].sort();
  const pressureFamilies = familiesFired.filter(
    (f) => !(non_pressure_families as string[]).includes(f),
  );
  const combo = critical_combinations.find((c) => satisfied(c, fired)) ?? null;

  let decision: Decision = "ALLOW";
  if (highRisk && (pressureFamilies.length >= pause_min_families || combo)) decision = "PAUSE";
  else if ((highRisk && fired.length > 0) || pressureFamilies.length >= pause_min_families)
    decision = "WARN";

  return {
    decision,
    fired,
    familiesFired,
    pressureFamilies,
    criticalCombination: combo?.id ?? null,
  };
}
