import { z } from "zod";

/**
 * Domain model for Manipulation Shield.
 *
 * Principle 2 ("analyze requests, not employees") is enforced structurally here:
 * no schema carries recipient identity, employee identifiers or per-person scores.
 * Routing an alert to a recipient is a connector concern and never enters the engine.
 * See test/principles.test.ts.
 */

export const ChannelSchema = z.enum(["email", "chat", "approval", "call", "ticket", "other"]);
export type Channel = z.infer<typeof ChannelSchema>;

/** One inbound piece of a request: an email, a chat message, an approval event, a call note. */
export const ArtifactSchema = z.object({
  id: z.string(),
  channel: ChannelSchema,
  receivedAt: z.string().datetime({ offset: true }).optional(),
  sender: z
    .object({
      address: z.string().optional(),
      displayName: z.string().optional(),
    })
    .default({}),
  replyTo: z.string().optional(),
  subject: z.string().optional(),
  body: z.string(),
  /** Quoted history stripped from the body; kept as context, never as evidence. */
  quoted: z.string().optional(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const ActionKindSchema = z.enum([
  "payment",
  "vendor_bank_change",
  "credential_reset",
  "access_grant",
  "data_export",
  "none",
]);
export type ActionKind = z.infer<typeof ActionKindSchema>;

/** The action the request is trying to get someone to take. Intervention happens here. */
export const ActionSchema = z.object({
  kind: ActionKindSchema.default("none"),
  amount: z.number().nonnegative().optional(),
  currency: z.string().optional(),
  /** Vendor master record id, payment id, or ticket id: the correlation key across channels. */
  objectId: z.string().optional(),
});
export type Action = z.infer<typeof ActionSchema>;

/**
 * Baselines are keyed on vendors, workflows and roles, never on individual employees.
 */
export const RequestContextSchema = z.object({
  /** Domains the organization owns, for lookalike detection. */
  orgDomains: z.array(z.string()).default([]),
  /** Sender domains already known for this vendor or workflow. */
  knownSenderDomains: z.array(z.string()).default([]),
  vendorBaseline: z
    .object({
      typicalAmount: z.number().nonnegative().optional(),
      bankDetailsLastChangedAt: z.string().optional(),
    })
    .optional(),
  businessHours: z
    .object({
      startHour: z.number().int().min(0).max(23),
      endHour: z.number().int().min(1).max(24),
      utcOffsetMinutes: z.number().int().default(0),
    })
    .optional(),
});
export type RequestContext = z.infer<typeof RequestContextSchema>;

/** The unit of analysis: one action, with every artifact that pushes for it, across channels. */
export const ShieldRequestSchema = z.object({
  id: z.string(),
  action: ActionSchema.default({ kind: "none" }),
  artifacts: z.array(ArtifactSchema).min(1),
  context: RequestContextSchema.default({}),
});
export type ShieldRequest = z.infer<typeof ShieldRequestSchema>;
export type ShieldRequestInput = z.input<typeof ShieldRequestSchema>;

export const DecisionSchema = z.enum(["ALLOW", "WARN", "PAUSE"]);
export type Decision = z.infer<typeof DecisionSchema>;

export const DECISION_RANK: Record<Decision, number> = { ALLOW: 0, WARN: 1, PAUSE: 2 };

export const HitSourceSchema = z.enum(["rules", "llm", "both"]);
export type HitSource = z.infer<typeof HitSourceSchema>;

export const TacticHitSchema = z.object({
  tacticId: z.string(),
  family: z.string(),
  confidence: z.number().min(0).max(1),
  /** Verbatim spans from the request, or feature ids for structural evidence. */
  evidence: z.array(z.string()),
  source: HitSourceSchema,
});
export type TacticHit = z.infer<typeof TacticHitSchema>;

export const FeatureResultSchema = z.object({
  id: z.string(),
  fired: z.boolean(),
  detail: z.string().optional(),
});
export type FeatureResult = z.infer<typeof FeatureResultSchema>;

export const ProvenanceSchema = z.object({
  engineVersion: z.string(),
  libraryVersion: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  promptHash: z.string().nullable(),
  llmStatus: z.enum([
    "not_called",
    "skipped_prefilter",
    "skipped_budget",
    "ok",
    "refused",
    "error",
  ]),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const AnalysisSchema = z.object({
  requestId: z.string(),
  decision: DecisionSchema,
  highRiskAction: z.boolean(),
  intents: z.array(z.string()),
  hits: z.array(TacticHitSchema),
  familiesFired: z.array(z.string()),
  criticalCombination: z.string().nullable(),
  /** One line per fired tactic. Names the tactic, never the person. */
  explanations: z.array(z.string()),
  features: z.array(FeatureResultSchema),
  provenance: ProvenanceSchema,
});
export type Analysis = z.infer<typeof AnalysisSchema>;

/** Outcome of a forced verification. The ground-truth label behind the data flywheel. */
export const VerificationOutcomeSchema = z.object({
  requestId: z.string(),
  channelUsed: z.enum(["vendor_master_contact", "directory_phone", "in_person", "other"]),
  outcome: z.enum(["legitimate", "attack", "inconclusive"]),
  completedAt: z.string(),
  durationSeconds: z.number().nonnegative(),
});
export type VerificationOutcome = z.infer<typeof VerificationOutcomeSchema>;

/**
 * Deterministic feature ids the engine computes. Tactics reference these as structural
 * indicators; they live here so the tactic linter can validate them without importing the engine.
 */
export const FEATURE_IDS = [
  "reply_to_mismatch",
  "display_name_spoof",
  "lookalike_domain",
  "unknown_sender_domain",
  "cross_channel_sequence",
  "action_vendor_bank_change",
  "amount_outlier",
  "off_hours",
] as const;
export type FeatureId = (typeof FEATURE_IDS)[number];
