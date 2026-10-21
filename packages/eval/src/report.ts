import type { Rate } from "./metrics.ts";
import type { EvalResult } from "./run.ts";

const pct = (r: Rate) =>
  r.value === null
    ? "n/a"
    : `${(r.value * 100).toFixed(1)}% (${r.num}/${r.den}; 95% CI ${(r.ci[0] * 100).toFixed(0)}–${(r.ci[1] * 100).toFixed(0)}%)`;
const short = (r: Rate) =>
  r.value === null ? "n/a" : `${(r.value * 100).toFixed(0)}% (${r.num}/${r.den})`;

export function renderReport(
  r: EvalResult,
  opts: { date?: string; gateFailures?: string[] } = {},
): string {
  const lines: string[] = [];
  lines.push(`# Manipulation Shield: eval report`);
  lines.push("");
  lines.push(
    `- Date: ${opts.date ?? new Date().toISOString().slice(0, 10)}\n- Provider: \`${r.provider}\`${r.model ? ` (model \`${r.model}\`)` : " (rules only)"}\n- Tactic library: ${r.libraryVersion}\n- Corpus: ${r.corpusSize} items (${r.confusion.attack.ALLOW + r.confusion.attack.WARN + r.confusion.attack.PAUSE} attacks, ${r.confusion.legit.ALLOW + r.confusion.legit.WARN + r.confusion.legit.PAUSE} legitimate)`,
  );
  if (Object.keys(r.llmStatus).length) {
    lines.push(
      `- LLM calls: ${Object.entries(r.llmStatus)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}`,
    );
  }
  lines.push("");
  lines.push(
    "> Read with care: this corpus is synthetic and written by the same team that wrote the tactic library, so these numbers are an optimistic ceiling, not a field result. The `tag:paraphrase` slice, worded to avoid the lexicons, is the closer proxy. Field precision comes from partner shadow mode; see docs/eval-methodology.md.",
  );
  lines.push("");
  if (opts.gateFailures) {
    lines.push(
      opts.gateFailures.length === 0
        ? "**CI gate: pass**"
        : `**CI gate: FAIL**\n\n${opts.gateFailures.map((f) => `- ${f}`).join("\n")}`,
    );
    lines.push("");
  }

  lines.push("## Decision quality (PAUSE = positive)");
  lines.push("");
  lines.push("| Metric | PAUSE | WARN or above |");
  lines.push("|---|---|---|");
  lines.push(`| Precision | ${pct(r.pause.precision)} | ${pct(r.warnOrAbove.precision)} |`);
  lines.push(`| Catch rate (recall) | ${pct(r.pause.recall)} | ${pct(r.warnOrAbove.recall)} |`);
  lines.push(
    `| False-alarm rate (legit) | ${pct(r.pause.falseAlarmRate)} | ${pct(r.warnOrAbove.falseAlarmRate)} |`,
  );
  lines.push("");
  lines.push("| Truth \\ Decision | ALLOW | WARN | PAUSE |");
  lines.push("|---|---|---|---|");
  for (const k of ["attack", "legit"] as const)
    lines.push(
      `| ${k} | ${r.confusion[k].ALLOW} | ${r.confusion[k].WARN} | ${r.confusion[k].PAUSE} |`,
    );
  lines.push("");

  lines.push("## Slices");
  lines.push("");
  lines.push(
    "| Slice | Attacks | Legit | PAUSE catch rate | WARN+ catch rate | PAUSE false-alarm rate |",
  );
  lines.push("|---|---|---|---|---|---|");
  for (const s of r.slices)
    lines.push(
      `| ${s.name} | ${s.attacks} | ${s.legit} | ${short(s.pauseRecall)} | ${short(s.warnOrAboveRecall)} | ${short(s.pauseFalseAlarmRate)} |`,
    );
  lines.push("");

  lines.push("## Tactic detection");
  lines.push("");
  lines.push(
    "Tactic labels are independent of the attack label: a real urgent request still uses urgency.",
  );
  lines.push("");
  lines.push("| Tactic | Support | Precision | Recall |");
  lines.push("|---|---|---|---|");
  for (const t of r.tactics)
    lines.push(`| \`${t.id}\` | ${t.support} | ${short(t.precision)} | ${short(t.recall)} |`);
  lines.push("");

  lines.push("## Injection robustness");
  lines.push("");
  lines.push(
    `${r.injectionPairs.checked} injected/clean pairs checked; ${r.injectionPairs.violations.length} where the injection lowered the verdict.`,
  );
  for (const v of r.injectionPairs.violations) lines.push(`- ${v}`);
  lines.push("");

  const list = (title: string, items: EvalResult["results"]) => {
    lines.push(`## ${title} (${items.length})`);
    lines.push("");
    for (const x of items.slice(0, 40))
      lines.push(
        `- \`${x.item.id}\` → ${x.analysis.decision}; fired: ${x.detected.join(", ") || "none"}; labeled: ${x.item.labels.tactics.join(", ") || "none"}`,
      );
    if (items.length > 40) lines.push(`- … ${items.length - 40} more`);
    lines.push("");
  };
  list("False alarms (legitimate, paused)", r.falseAlarms);
  list("Misses (attack, not paused)", r.misses);
  return lines.join("\n");
}
