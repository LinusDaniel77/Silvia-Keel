import { z } from "zod";

export const FAMILIES = [
  "urgency",
  "authority",
  "secrecy",
  "channel",
  "identity",
  "process-bypass",
  "payment-anomaly",
  "access",
  "rapport",
  "injection",
  "elicitation",
] as const;
export const FamilySchema = z.enum(FAMILIES);
export type Family = z.infer<typeof FamilySchema>;

export const StageSchema = z.enum(["enterprise", "elicitation", "copilot"]);

export const SeveritySchema = z.enum(["low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof SeveritySchema>;

const SEMVER = /^\d+\.\d+\.\d+$/;

export const TacticSchema = z
  .object({
    id: z.string().regex(/^[a-z-]+\.[a-z0-9-]+$/, "id must look like family.slug"),
    name: z.string().min(3),
    family: FamilySchema,
    stages: z.array(StageSchema).min(1),
    version: z.string().regex(SEMVER),
    status: z.enum(["draft", "active", "deprecated"]),
    severity: SeveritySchema,
    description: z.string().min(20),
    /**
     * One line shown to the employee. `{evidence}` is replaced with the first quoted span.
     * Must describe the tactic, never the sender.
     */
    explanation: z.string().min(10),
    indicators: z
      .object({
        /** Case-insensitive phrases. Matched on word boundaries. */
        lexical: z.array(z.string().min(2)).default([]),
        /** Case-insensitive regular expressions for phrasing a word list can't express. */
        patterns: z.array(z.string()).default([]),
        /** Deterministic feature ids from the engine (see engine/src/features.ts). */
        structural: z.array(z.string()).default([]),
      })
      .default({}),
    examples: z.object({
      positive: z.array(z.string().min(10)).min(1),
      hard_negative: z.array(z.string().min(10)).min(1),
    }),
    references: z.array(z.string()).default([]),
    author: z.string(),
  })
  .strict();
export type Tactic = z.infer<typeof TacticSchema>;

/** A rule that pauses on its own when all of its requirements fire. */
export const CriticalCombinationSchema = z
  .object({
    id: z.string(),
    description: z.string(),
    /** Each entry is a tactic id or `family:<name>`. All must fire. */
    requires: z.array(z.string()).min(2),
  })
  .strict();
export type CriticalCombination = z.infer<typeof CriticalCombinationSchema>;

export const ManifestSchema = z
  .object({
    version: z.string().regex(SEMVER),
    /** Hit confidence at or above which a tactic counts as fired. */
    fire_threshold: z.number().min(0).max(1),
    /** Distinct pressure families needed to pause a high-risk action. */
    pause_min_families: z.number().int().min(1),
    /**
     * Families that describe the action itself rather than pressure on a human.
     * They count toward critical combinations but not toward pause_min_families,
     * so a legitimate bank-change request is not paused just for being one.
     */
    non_pressure_families: z.array(FamilySchema).default([]),
    critical_combinations: z.array(CriticalCombinationSchema).default([]),
  })
  .strict();
export type Manifest = z.infer<typeof ManifestSchema>;
