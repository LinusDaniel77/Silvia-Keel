import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { ManifestSchema, TacticSchema, type Manifest, type Tactic } from "./schema.ts";

export const DEFAULT_LIBRARY_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../library",
);

export interface TacticLibrary {
  dir: string;
  manifest: Manifest;
  /** Active tactics only. Drafts and deprecated tactics never reach the engine. */
  tactics: Tactic[];
  byId: Map<string, Tactic>;
}

export interface RawLibrary {
  dir: string;
  manifest: unknown;
  files: { file: string; data: unknown }[];
}

export function readRawLibrary(dir = DEFAULT_LIBRARY_DIR): RawLibrary {
  const manifest = YAML.parse(readFileSync(path.join(dir, "manifest.yaml"), "utf8"));
  const tacticDir = path.join(dir, "tactics");
  const files = readdirSync(tacticDir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((file) => ({ file, data: YAML.parse(readFileSync(path.join(tacticDir, file), "utf8")) }));
  return { dir, manifest, files };
}

/** Loads and validates the library. Throws on any schema error; run the linter for details. */
export function loadLibrary(dir = DEFAULT_LIBRARY_DIR): TacticLibrary {
  const raw = readRawLibrary(dir);
  const manifest = ManifestSchema.parse(raw.manifest);
  const all = raw.files.map(({ file, data }) => {
    const parsed = TacticSchema.safeParse(data);
    if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues[0]?.message}`);
    return parsed.data;
  });
  const tactics = all.filter((t) => t.status === "active");
  return { dir, manifest, tactics, byId: new Map(tactics.map((t) => [t.id, t])) };
}

/** Content hash of a tactic, excluding its version, so edits without a version bump are caught. */
export function tacticHash(tactic: Tactic): string {
  const { version: _version, ...content } = tactic;
  return createHash("sha256").update(canonicalJson(content)).digest("hex").slice(0, 16);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
