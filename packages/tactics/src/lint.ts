import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FEATURE_IDS } from "@shield/shared";
import { canonicalJson, readRawLibrary, tacticHash, DEFAULT_LIBRARY_DIR } from "./loader.ts";
import { matchIndicators } from "./match.ts";
import { ManifestSchema, TacticSchema, type Tactic } from "./schema.ts";

/**
 * Words that label a person instead of a tactic (principle 3). Banned from anything an
 * employee sees: tactic names and explanations, and engine output (see engine principles test).
 */
export const PERSON_LABELS = [
  "fraudster",
  "scammer",
  "con artist",
  "criminal",
  "liar",
  "impostor",
  "imposter",
  "bad actor",
  "malicious sender",
  "this sender is",
  "this person is",
  "the sender is lying",
  "attacker",
];

export function findPersonLabels(text: string): string[] {
  const lower = text.toLowerCase();
  return PERSON_LABELS.filter((label) => lower.includes(label));
}

export const MIN_EXAMPLES = 2;

export interface LintReport {
  errors: string[];
  warnings: string[];
  stats: { tactics: number; active: number; families: Record<string, number> };
}

interface LockFile {
  libraryVersion: string;
  libraryHash: string;
  tactics: Record<string, { version: string; hash: string }>;
}

const lockPath = (dir: string) => path.join(dir, "library.lock.json");

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function buildLock(libraryVersion: string, tactics: Tactic[]): LockFile {
  const entries = Object.fromEntries(
    tactics
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((t) => [t.id, { version: t.version, hash: tacticHash(t) }]),
  );
  return {
    libraryVersion,
    libraryHash: tacticHashOfAll(entries),
    tactics: entries,
  };
}

function tacticHashOfAll(entries: LockFile["tactics"]): string {
  return Buffer.from(
    canonicalJson(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, v.hash]))),
  )
    .toString("base64url")
    .slice(-16);
}

export function lintLibrary(dir = DEFAULT_LIBRARY_DIR): LintReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const raw = readRawLibrary(dir);

  const manifest = ManifestSchema.safeParse(raw.manifest);
  if (!manifest.success) {
    for (const issue of manifest.error.issues)
      errors.push(`manifest.yaml: ${issue.path.join(".")}: ${issue.message}`);
  }

  const tactics: Tactic[] = [];
  const seen = new Set<string>();
  for (const { file, data } of raw.files) {
    const parsed = TacticSchema.safeParse(data);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        errors.push(`${file}: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
      continue;
    }
    const t = parsed.data;
    tactics.push(t);
    if (file !== `${t.id}.yaml`) errors.push(`${file}: file name must be ${t.id}.yaml`);
    if (seen.has(t.id)) errors.push(`${file}: duplicate id ${t.id}`);
    seen.add(t.id);
    if (!t.id.startsWith(`${t.family}.`))
      errors.push(`${file}: id must start with its family "${t.family}."`);

    for (const label of findPersonLabels(`${t.name}\n${t.explanation}`))
      errors.push(
        `${file}: names or explanations must label the tactic, not the person (found "${label}")`,
      );

    let patternsValid = true;
    for (const p of t.indicators.patterns) {
      try {
        new RegExp(p, "i");
      } catch (e) {
        patternsValid = false;
        errors.push(`${file}: invalid pattern ${JSON.stringify(p)}: ${(e as Error).message}`);
      }
    }
    for (const s of t.indicators.structural) {
      if (!(FEATURE_IDS as readonly string[]).includes(s))
        errors.push(
          `${file}: unknown structural feature "${s}" (known: ${FEATURE_IDS.join(", ")})`,
        );
    }

    if (t.status === "active") {
      if (t.examples.positive.length < MIN_EXAMPLES)
        errors.push(`${file}: active tactics need at least ${MIN_EXAMPLES} positive examples`);
      if (t.examples.hard_negative.length < MIN_EXAMPLES)
        errors.push(`${file}: active tactics need at least ${MIN_EXAMPLES} hard negatives`);
      const { lexical, patterns, structural } = t.indicators;
      if (lexical.length + patterns.length + structural.length === 0)
        errors.push(`${file}: active tactics need at least one indicator`);

      if (patternsValid && lexical.length + patterns.length > 0) {
        const uncovered = t.examples.positive.filter((ex) => matchIndicators(t, ex).length === 0);
        if (uncovered.length > 0)
          warnings.push(
            `${file}: ${uncovered.length}/${t.examples.positive.length} positive examples are not matched by rules (LLM-only coverage)`,
          );
        const tripped = t.examples.hard_negative.filter((ex) => matchIndicators(t, ex).length > 0);
        if (tripped.length > 0)
          warnings.push(
            `${file}: ${tripped.length}/${t.examples.hard_negative.length} hard negatives match the rules (precision risk; fine only if the cue is genuinely present)`,
          );
      }
    }
  }

  if (manifest.success) {
    const ids = new Set(tactics.filter((t) => t.status === "active").map((t) => t.id));
    const families = new Set(tactics.map((t) => t.family));
    for (const combo of manifest.data.critical_combinations) {
      for (const req of combo.requires) {
        const ok = req.startsWith("family:")
          ? families.has(req.slice(7) as Tactic["family"])
          : ids.has(req);
        if (!ok)
          errors.push(`manifest.yaml: critical combination ${combo.id} requires unknown "${req}"`);
      }
    }

    // Version discipline: content changes need a version bump, recorded in library.lock.json.
    const lock = existsSync(lockPath(dir))
      ? (JSON.parse(readFileSync(lockPath(dir), "utf8")) as LockFile)
      : null;
    if (!lock) {
      errors.push("library.lock.json missing: run `pnpm shield tactics lock`");
    } else {
      const next = buildLock(manifest.data.version, tactics);
      const before = errors.length;
      let changed = false;
      for (const [id, entry] of Object.entries(next.tactics)) {
        const prev = lock.tactics[id];
        if (!prev) {
          changed = true;
          continue;
        }
        if (prev.hash !== entry.hash) {
          changed = true;
          if (compareSemver(entry.version, prev.version) <= 0)
            errors.push(
              `${id}.yaml: content changed without a version bump (still ${entry.version})`,
            );
        } else if (prev.version !== entry.version) changed = true;
      }
      if (Object.keys(lock.tactics).some((id) => !next.tactics[id])) changed = true;
      if (changed && compareSemver(manifest.data.version, lock.libraryVersion) <= 0)
        errors.push(
          `manifest.yaml: library content changed; bump version above ${lock.libraryVersion}`,
        );
      if (changed && errors.length === before)
        errors.push("library.lock.json is stale: run `pnpm shield tactics lock`");
    }
  }

  const familyCounts: Record<string, number> = {};
  for (const t of tactics.filter((x) => x.status === "active"))
    familyCounts[t.family] = (familyCounts[t.family] ?? 0) + 1;

  return {
    errors,
    warnings,
    stats: {
      tactics: tactics.length,
      active: tactics.filter((t) => t.status === "active").length,
      families: familyCounts,
    },
  };
}

/** Rewrites library.lock.json from the current library. Refuses while other lint errors exist. */
export function writeLock(dir = DEFAULT_LIBRARY_DIR): LockFile {
  const raw = readRawLibrary(dir);
  const manifest = ManifestSchema.parse(raw.manifest);
  const tactics = raw.files.map(({ data }) => TacticSchema.parse(data));
  const remaining = lintLibrary(dir).errors.filter((e) => !e.startsWith("library.lock.json"));
  if (remaining.length > 0)
    throw new Error(`fix lint errors before locking:\n${remaining.join("\n")}`);
  const lock = buildLock(manifest.version, tactics);
  writeFileSync(lockPath(dir), `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}
