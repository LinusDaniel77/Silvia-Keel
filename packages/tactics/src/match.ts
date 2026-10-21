import type { Tactic } from "./schema.ts";

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const compiled = new WeakMap<Tactic, RegExp[]>();

/**
 * Lexical phrases become word-bounded, whitespace-tolerant, case-insensitive regexes that also
 * accept a plural ending ("gift card" matches "gift cards").
 */
export function indicatorRegexes(tactic: Tactic): RegExp[] {
  let res = compiled.get(tactic);
  if (!res) {
    const lexical = tactic.indicators.lexical.map(
      (phrase) =>
        new RegExp(
          `(?<![\\w])${escapeRegex(phrase.trim()).replace(/\s+/g, "\\s+")}(?:s|es)?(?![\\w])`,
          "i",
        ),
    );
    const patterns = tactic.indicators.patterns.map((p) => new RegExp(p, "i"));
    res = [...lexical, ...patterns];
    compiled.set(tactic, res);
  }
  return res;
}

/** Returns the verbatim spans in `text` that match the tactic's lexical or pattern indicators. */
export function matchIndicators(tactic: Tactic, text: string): string[] {
  const spans: string[] = [];
  for (const re of indicatorRegexes(tactic)) {
    const m = re.exec(text);
    if (m && m[0] && !spans.includes(m[0])) spans.push(m[0]);
  }
  // Keep the longest of overlapping matches: "Updated remittance info" subsumes "Updated remittance".
  const lower = spans.map((s) => s.toLowerCase());
  return spans.filter(
    (s, i) => !lower.some((o, j) => j !== i && o.length > s.length && o.includes(lower[i]!)),
  );
}
