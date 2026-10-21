import type { TacticHit } from "@shield/shared";
import type { TacticLibrary } from "@shield/tactics";
import type { RawHits } from "./types.ts";

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Turns untrusted model output into hits. Unknown tactic ids are dropped, confidence is
 * clamped, and every evidence span must appear verbatim (modulo whitespace and case) in the
 * request text. A hit with no surviving evidence is dropped: no quote, no flag.
 */
export function validateHits(
  raw: RawHits["hits"],
  library: TacticLibrary,
  requestText: string,
): { hits: TacticHit[]; rejected: { tacticId: string; reason: string }[] } {
  const haystack = squash(requestText);
  const hits: TacticHit[] = [];
  const rejected: { tacticId: string; reason: string }[] = [];
  for (const h of raw) {
    const tactic = library.byId.get(h.tactic_id);
    if (!tactic) {
      rejected.push({ tacticId: h.tactic_id, reason: "unknown tactic id" });
      continue;
    }
    const evidence = [
      ...new Set(h.evidence.map((e) => e.trim()).filter((e) => e.length >= 3)),
    ].filter((e) => haystack.includes(squash(e)));
    if (evidence.length === 0) {
      rejected.push({ tacticId: h.tactic_id, reason: "no verbatim evidence" });
      continue;
    }
    const confidence = Number.isFinite(h.confidence) ? Math.min(1, Math.max(0, h.confidence)) : 0;
    const existing = hits.find((x) => x.tacticId === tactic.id);
    if (existing) {
      existing.confidence = Math.max(existing.confidence, confidence);
      existing.evidence = [...new Set([...existing.evidence, ...evidence])];
    } else {
      hits.push({
        tacticId: tactic.id,
        family: tactic.family,
        confidence,
        evidence,
        source: "llm",
      });
    }
  }
  return { hits, rejected };
}
