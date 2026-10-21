import type { TacticHit } from "@shield/shared";
import type { TacticLibrary } from "@shield/tactics";

const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One line per fired tactic, from the tactic's own template. Names the tactic, never the person. */
export function explain(library: TacticLibrary, fired: TacticHit[]): string[] {
  return fired.map((h) => {
    const t = library.byId.get(h.tacticId);
    const evidence = clip((h.evidence[0] ?? "").replace(/\s+/g, " ").trim());
    return t ? t.explanation.replace("{evidence}", evidence) : h.tacticId;
  });
}
