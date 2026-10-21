import { createHash } from "node:crypto";
import type { Db } from "@shield/db";
import { analyze, analysisText, correlate, type CorrelationCandidate } from "@shield/engine";
import type { LlmProvider } from "@shield/llm";
import type { Action, ActionKind, Analysis, Artifact, Channel } from "@shield/shared";
import type { TacticLibrary } from "@shield/tactics";
import { callbackScript, pickContact, type KnownContact, type Subject } from "./verification.ts";

/**
 * Domain operations. Every function takes a transaction already scoped to one tenant by
 * withTenant(), so row-level security confines it to that tenant's rows.
 */

export class NotFound extends Error {}
export class Conflict extends Error {}

export type NewArtifact = Omit<Artifact, "id">;

interface RequestRow {
  id: string;
  object_ids: string[];
  action_kind: ActionKind;
  claimed_requester: string | null;
  created_at: string | Date;
  text: string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const toDate = (v: string | Date) => (v instanceof Date ? v : new Date(v));

async function openCandidates(tx: Db): Promise<CorrelationCandidate[]> {
  const { rows } = await tx.query<RequestRow>(
    `SELECT r.id, r.object_ids, r.action_kind, r.claimed_requester, r.created_at,
            coalesce(string_agg(coalesce(a.subject, '') || E'\\n' || coalesce(a.body, ''), E'\\n\\n'), '') AS text
       FROM requests r LEFT JOIN artifacts a ON a.request_id = r.id
      WHERE r.status IN ('open', 'held') AND r.created_at > now() - interval '14 days'
      GROUP BY r.id`,
  );
  return rows.map((r) => ({
    id: r.id,
    objectIds: r.object_ids,
    text: r.text,
    actionKind: r.action_kind,
    claimedRequester: r.claimed_requester,
    createdAt: toDate(r.created_at),
  }));
}

/** Finds the open request this belongs to, or opens a new one. */
async function attach(
  tx: Db,
  tenantId: string,
  input: {
    objectIds: string[];
    text: string;
    actionKind: ActionKind;
    claimedRequester: string | null;
  },
): Promise<{ requestId: string; correlatedBy: string | null }> {
  const match = correlate({ ...input, at: new Date() }, await openCandidates(tx));
  if (match) {
    await tx.query(
      `UPDATE requests
          SET object_ids = ARRAY(SELECT DISTINCT unnest(object_ids || $2::text[])),
              claimed_requester = coalesce(claimed_requester, $3),
              action_kind = CASE WHEN action_kind = 'none' THEN $4 ELSE action_kind END,
              updated_at = now()
        WHERE id = $1`,
      [match.id, input.objectIds, input.claimedRequester, input.actionKind],
    );
    return { requestId: match.id, correlatedBy: match.rule };
  }
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO requests (tenant_id, action, action_kind, object_ids, claimed_requester)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      tenantId,
      JSON.stringify({ kind: input.actionKind }),
      input.actionKind,
      input.objectIds,
      input.claimedRequester,
    ],
  );
  return { requestId: rows[0]!.id, correlatedBy: null };
}

async function insertArtifact(
  tx: Db,
  tenantId: string,
  requestId: string,
  a: NewArtifact,
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO artifacts (tenant_id, request_id, channel, sender_address, sender_display, reply_to, subject, body, body_sha256, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      tenantId,
      requestId,
      a.channel,
      a.sender.address ?? null,
      a.sender.displayName ?? null,
      a.replyTo ?? null,
      a.subject ?? null,
      a.body,
      sha256(a.body),
      a.receivedAt ?? null,
    ],
  );
  return rows[0]!.id;
}

const claimedRequesterOf = (a: NewArtifact) => a.sender.displayName ?? a.sender.address ?? null;

export interface CorrelationHints {
  objectIds: string[];
  claimedRequester?: string;
  actionKind?: ActionKind;
}

export async function ingestArtifact(
  tx: Db,
  tenantId: string,
  artifact: NewArtifact,
  hints: CorrelationHints,
) {
  const { requestId, correlatedBy } = await attach(tx, tenantId, {
    objectIds: hints.objectIds,
    text: analysisText([{ ...artifact, id: "new" }]),
    actionKind: hints.actionKind ?? "none",
    claimedRequester: hints.claimedRequester ?? claimedRequesterOf(artifact),
  });
  const artifactId = await insertArtifact(tx, tenantId, requestId, artifact);
  return { requestId, artifactId, correlatedBy };
}

interface ArtifactRow {
  id: string;
  channel: Channel;
  sender_address: string | null;
  sender_display: string | null;
  reply_to: string | null;
  subject: string | null;
  body: string | null;
  received_at: string | Date | null;
  purged_at: string | Date | null;
}

const rowToArtifact = (r: ArtifactRow): Artifact => ({
  id: r.id,
  channel: r.channel,
  sender: {
    ...(r.sender_address ? { address: r.sender_address } : {}),
    ...(r.sender_display ? { displayName: r.sender_display } : {}),
  },
  ...(r.reply_to ? { replyTo: r.reply_to } : {}),
  ...(r.subject ? { subject: r.subject } : {}),
  body: r.body ?? "",
  ...(r.received_at ? { receivedAt: toDate(r.received_at).toISOString() } : {}),
});

async function requestArtifacts(tx: Db, requestId: string): Promise<ArtifactRow[]> {
  return (
    await tx.query<ArtifactRow>(
      `SELECT id, channel, sender_address, sender_display, reply_to, subject, body, received_at, purged_at
         FROM artifacts WHERE request_id = $1 ORDER BY coalesce(received_at, created_at), created_at`,
      [requestId],
    )
  ).rows;
}

async function contactsFor(tx: Db, subject: Subject): Promise<KnownContact[]> {
  return (
    await tx.query<KnownContact>(
      "SELECT id, channel, value, source FROM known_contacts WHERE subject_type = $1 AND subject_id = $2 ORDER BY updated_at DESC",
      [subject.type, subject.id],
    )
  ).rows;
}

export interface ApprovalCheck {
  action: Action;
  objectIds: string[];
  claimedRequester?: string;
  subject: Subject;
  artifacts: NewArtifact[];
}

export interface CheckDeps {
  library: TacticLibrary;
  provider?: LlmProvider;
}

/**
 * The gate. Joins the approval to its request, analyzes every artifact the request has, records
 * the analysis, and in enforce mode holds a paused request until it is verified through a
 * known-good contact. In shadow mode nothing is held; the would-be decision is recorded.
 */
export async function checkApproval(
  tx: Db,
  tenantId: string,
  body: ApprovalCheck,
  deps: CheckDeps,
) {
  const { requestId, correlatedBy } = await attach(tx, tenantId, {
    objectIds: body.objectIds,
    text: analysisText(body.artifacts.map((a, i) => ({ ...a, id: `inline-${i}` }))),
    actionKind: body.action.kind,
    claimedRequester: body.claimedRequester ?? null,
  });
  await tx.query(
    "UPDATE requests SET action = $2, action_kind = $3, updated_at = now() WHERE id = $1",
    [requestId, JSON.stringify(body.action), body.action.kind],
  );
  for (const a of body.artifacts) await insertArtifact(tx, tenantId, requestId, a);

  const artifacts = (await requestArtifacts(tx, requestId)).map(rowToArtifact);
  const contacts = await contactsFor(tx, body.subject);
  const orgDomains =
    (await tx.query<{ org_domains: string[] }>("SELECT org_domains FROM tenants")).rows[0]
      ?.org_domains ?? [];
  const knownSenderDomains = [
    ...new Set(
      contacts
        .filter((c) => c.channel === "email")
        .map((c) => c.value.split("@")[1]!.toLowerCase()),
    ),
  ];

  const analysis: Analysis = artifacts.length
    ? await analyze(
        {
          id: requestId,
          action: body.action,
          artifacts,
          context: { orgDomains, knownSenderDomains },
        },
        deps,
      )
    : await analyze(
        // An approval with no message attached is judged on its action alone.
        {
          id: requestId,
          action: body.action,
          artifacts: [{ id: "none", channel: "approval", body: "" }],
        },
        deps,
      );

  const mode =
    (
      await tx.query<{ mode: "shadow" | "enforce" }>(
        "SELECT mode FROM workflow_settings WHERE action_kind = $1",
        [body.action.kind],
      )
    ).rows[0]?.mode ?? "shadow";
  const hold = mode === "enforce" && analysis.decision === "PAUSE";

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO analyses (tenant_id, request_id, decision, mode, held, hits, explanations, provenance)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      tenantId,
      requestId,
      analysis.decision,
      mode,
      hold,
      JSON.stringify(analysis.hits),
      JSON.stringify(analysis.explanations),
      JSON.stringify(analysis.provenance),
    ],
  );
  const analysisId = rows[0]!.id;

  let verification: {
    id: string;
    status: string;
    script: string;
    contact: KnownContact | null;
  } | null = null;
  if (hold) {
    const contact = pickContact(contacts);
    const script = callbackScript(body.action, body.subject, contact);
    const status = contact ? "pending" : "needs_contact";
    const v = await tx.query<{ id: string }>(
      `INSERT INTO verifications (tenant_id, request_id, analysis_id, status, contact_id, script)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantId, requestId, analysisId, status, contact?.id ?? null, script],
    );
    await tx.query("UPDATE requests SET status = 'held', updated_at = now() WHERE id = $1", [
      requestId,
    ]);
    verification = { id: v.rows[0]!.id, status, script, contact };
  }

  return {
    requestId,
    correlatedBy,
    decision: analysis.decision,
    mode,
    hold,
    wouldHold: analysis.decision === "PAUSE",
    criticalCombination: analysis.criticalCombination,
    explanations: analysis.explanations,
    tactics: analysis.hits
      .filter((h) => h.confidence >= deps.library.manifest.fire_threshold)
      .map((h) => ({
        id: h.tacticId,
        confidence: h.confidence,
        evidence: h.evidence,
        source: h.source,
      })),
    verification,
  };
}

const OUTCOME_STATUS = { legitimate: "released", attack: "blocked", inconclusive: "held" } as const;

export async function completeVerification(
  tx: Db,
  tenantId: string,
  id: string,
  body: { outcome: keyof typeof OUTCOME_STATUS; channelUsed: string },
  actorRef: string,
) {
  const { rows } = await tx.query<{ request_id: string }>(
    `UPDATE verifications SET status = 'completed', outcome = $2, channel_used = $3, completed_at = now()
      WHERE id = $1 AND status IN ('pending', 'needs_contact') RETURNING request_id`,
    [id, body.outcome, body.channelUsed],
  );
  const requestId = rows[0]?.request_id;
  if (!requestId) throw await missingOrDone(tx, id);
  const status = OUTCOME_STATUS[body.outcome];
  await tx.query("UPDATE requests SET status = $2, updated_at = now() WHERE id = $1", [
    requestId,
    status,
  ]);
  await audit(tx, tenantId, {
    requestId,
    verificationId: id,
    actorRef,
    event: `verification_${body.outcome}`,
  });
  return { requestId, outcome: body.outcome, requestStatus: status };
}

export async function overrideVerification(
  tx: Db,
  tenantId: string,
  id: string,
  reason: string,
  actorRef: string,
) {
  const { rows } = await tx.query<{ request_id: string }>(
    `UPDATE verifications SET status = 'overridden', completed_at = now()
      WHERE id = $1 AND status IN ('pending', 'needs_contact') RETURNING request_id`,
    [id],
  );
  const requestId = rows[0]?.request_id;
  if (!requestId) throw await missingOrDone(tx, id);
  await tx.query("UPDATE requests SET status = 'released', updated_at = now() WHERE id = $1", [
    requestId,
  ]);
  await audit(tx, tenantId, {
    requestId,
    verificationId: id,
    actorRef,
    event: "verification_overridden",
    reason,
  });
  return { requestId, requestStatus: "released" as const };
}

async function missingOrDone(tx: Db, id: string): Promise<Error> {
  const { rows } = await tx.query("SELECT 1 FROM verifications WHERE id = $1", [id]);
  return rows.length
    ? new Conflict("verification already closed")
    : new NotFound("verification not found");
}

async function audit(
  tx: Db,
  tenantId: string,
  e: {
    requestId?: string;
    verificationId?: string;
    actorRef: string;
    event: string;
    reason?: string;
  },
) {
  await tx.query(
    `INSERT INTO audit_events (tenant_id, request_id, verification_id, actor_ref, event, reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      tenantId,
      e.requestId ?? null,
      e.verificationId ?? null,
      e.actorRef,
      e.event,
      e.reason ?? null,
    ],
  );
}

export async function upsertContacts(
  tx: Db,
  tenantId: string,
  source: string,
  contacts: {
    subjectType: "vendor" | "role";
    subjectId: string;
    channel: "phone" | "email";
    value: string;
  }[],
) {
  for (const c of contacts)
    await tx.query(
      `INSERT INTO known_contacts (tenant_id, subject_type, subject_id, channel, value, source)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, subject_type, subject_id, channel, value)
       DO UPDATE SET source = EXCLUDED.source, updated_at = now()`,
      [tenantId, c.subjectType, c.subjectId, c.channel, c.value, source],
    );
  return { upserted: contacts.length };
}

export async function setWorkflowMode(
  tx: Db,
  tenantId: string,
  actionKind: ActionKind,
  mode: "shadow" | "enforce",
  actorRef: string,
) {
  await tx.query(
    `INSERT INTO workflow_settings (tenant_id, action_kind, mode) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, action_kind) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()`,
    [tenantId, actionKind, mode],
  );
  await audit(tx, tenantId, { actorRef, event: `workflow_${actionKind}_${mode}` });
  return { actionKind, mode };
}

export async function getRequest(tx: Db, id: string) {
  const req = (
    await tx.query(
      "SELECT id, action, object_ids, claimed_requester, status, created_at FROM requests WHERE id = $1",
      [id],
    )
  ).rows[0];
  if (!req) throw new NotFound("request not found");
  const artifacts = (await requestArtifacts(tx, id)).map((r) => ({
    ...rowToArtifact(r),
    purged: r.purged_at !== null,
  }));
  const analyses = (
    await tx.query(
      "SELECT id, decision, mode, held, hits, explanations, provenance, created_at FROM analyses WHERE request_id = $1 ORDER BY created_at",
      [id],
    )
  ).rows;
  const verifications = (
    await tx.query(
      "SELECT id, kind, status, script, outcome, channel_used, created_at, completed_at FROM verifications WHERE request_id = $1 ORDER BY created_at",
      [id],
    )
  ).rows;
  // The audit trail is the one place a person reference (actor_ref) is shown.
  const auditEvents = (
    await tx.query(
      "SELECT event, actor_ref, reason, created_at FROM audit_events WHERE request_id = $1 ORDER BY created_at",
      [id],
    )
  ).rows;
  return { request: req, artifacts, analyses, verifications, auditEvents };
}

/**
 * After-the-fact label for a checked request, mainly for shadow mode where nothing is held or
 * verified. It never changes a held request's status; that still needs complete or override.
 */
export async function reviewRequest(
  tx: Db,
  tenantId: string,
  requestId: string,
  outcome: "legitimate" | "attack" | "inconclusive",
  actorRef: string,
) {
  const analysis = (
    await tx.query<{ id: string }>(
      "SELECT id FROM analyses WHERE request_id = $1 ORDER BY created_at DESC LIMIT 1",
      [requestId],
    )
  ).rows[0];
  if (!analysis) {
    const exists = (await tx.query("SELECT 1 FROM requests WHERE id = $1", [requestId])).rows
      .length;
    throw exists
      ? new Conflict("request has not been checked yet")
      : new NotFound("request not found");
  }
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO verifications (tenant_id, request_id, analysis_id, kind, status, script, outcome, channel_used, completed_at)
     VALUES ($1, $2, $3, 'review', 'completed', 'Reviewed after the fact.', $4, 'review', now()) RETURNING id`,
    [tenantId, requestId, analysis.id, outcome],
  );
  await audit(tx, tenantId, {
    requestId,
    verificationId: rows[0]!.id,
    actorRef,
    event: `review_${outcome}`,
  });
  return { requestId, reviewId: rows[0]!.id, outcome };
}

/**
 * The flywheel: every verified request becomes a labelled eval item (`source: partner`). Only
 * the attack/legitimate verdict is known, so tactic labels are marked as not labelled.
 * Purged bodies are not exported.
 */
export async function exportLabels(tx: Db) {
  const { rows } = await tx.query<{
    request_id: string;
    outcome: "legitimate" | "attack";
    action: Action;
  }>(
    `SELECT DISTINCT ON (v.request_id) v.request_id, v.outcome, r.action
       FROM verifications v JOIN requests r ON r.id = v.request_id
      WHERE v.status = 'completed' AND v.outcome IN ('legitimate', 'attack')
      ORDER BY v.request_id, v.completed_at DESC`,
  );
  const items = [];
  for (const row of rows) {
    const artifacts = (await requestArtifacts(tx, row.request_id))
      .filter((a) => a.body !== null)
      .map(rowToArtifact);
    if (!artifacts.length) continue;
    items.push({
      id: `partner-${row.request_id}`,
      source: "partner" as const,
      tags: ["verified"],
      request: { id: row.request_id, action: row.action, artifacts },
      labels: { attack: row.outcome === "attack", tactics: [], tacticsLabeled: false },
    });
  }
  return items;
}
