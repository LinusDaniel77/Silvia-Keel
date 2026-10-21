import type { Db } from "@shield/db";
import { rate, type Rate } from "@shield/eval";
import type { Action, Decision, TacticHit } from "@shield/shared";
import type { TacticLibrary } from "@shield/tactics";

/**
 * Read models for the console. Every aggregate is keyed on workflow, tactic or vendor; nothing
 * here groups by, or returns, a person. Labels come from completed verifications: callbacks in
 * enforce mode and after-the-fact reviews in shadow mode.
 */

interface Row {
  id: string;
  action: Action;
  action_kind: string;
  object_ids: string[];
  status: string;
  created_at: string | Date;
  decision: Decision;
  mode: "shadow" | "enforce";
  held: boolean;
  hits: TacticHit[];
  outcome: "legitimate" | "attack" | null;
  label_kind: "callback" | "review" | null;
}

const LATEST = `
  FROM requests r
  JOIN LATERAL (SELECT decision, mode, held, hits FROM analyses a
                 WHERE a.request_id = r.id ORDER BY a.created_at DESC LIMIT 1) la ON true
  LEFT JOIN LATERAL (SELECT outcome, kind FROM verifications v
                      WHERE v.request_id = r.id AND v.status = 'completed' AND v.outcome IN ('legitimate', 'attack')
                      ORDER BY v.completed_at DESC LIMIT 1) lv ON true`;

const fired = (hits: TacticHit[], threshold: number) =>
  hits.filter((h) => h.confidence >= threshold);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export interface WorkflowSummary {
  actionKind: string;
  mode: "shadow" | "enforce";
  checks: number;
  decisions: Record<Decision, number>;
  wouldHold: number;
  held: number;
  labelled: { attack: number; legitimate: number };
  /** Of labelled pauses, how many were attacks. */
  pausePrecision: Rate;
  /** Of legitimate-labelled requests, how many were paused. */
  falseAlarmRate: Rate;
  /** Of attack-labelled requests, how many were paused. Biased by what reviewers chose to label. */
  catchRate: Rate;
}

export async function summary(tx: Db, library: TacticLibrary, days: number) {
  const threshold = library.manifest.fire_threshold;
  const rows = (
    await tx.query<Row>(
      `SELECT r.id, r.action, r.action_kind, r.object_ids, r.status, r.created_at,
              la.decision, la.mode, la.held, la.hits, lv.outcome, lv.kind AS label_kind
       ${LATEST}
       WHERE r.created_at > now() - make_interval(days => $1)`,
      [days],
    )
  ).rows;
  const modes = new Map(
    (
      await tx.query<{ action_kind: string; mode: "shadow" | "enforce" }>(
        "SELECT action_kind, mode FROM workflow_settings",
      )
    ).rows.map((r) => [r.action_kind, r.mode]),
  );

  const kinds = [...new Set([...rows.map((r) => r.action_kind), ...modes.keys()])]
    .filter((k) => k !== "none")
    .sort();
  const workflows: WorkflowSummary[] = kinds.map((kind) => {
    const rs = rows.filter((r) => r.action_kind === kind);
    const paused = rs.filter((r) => r.decision === "PAUSE");
    const labelledPauses = paused.filter((r) => r.outcome);
    const legit = rs.filter((r) => r.outcome === "legitimate");
    const attacks = rs.filter((r) => r.outcome === "attack");
    return {
      actionKind: kind,
      mode: modes.get(kind) ?? "shadow",
      checks: rs.length,
      decisions: {
        ALLOW: rs.filter((r) => r.decision === "ALLOW").length,
        WARN: rs.filter((r) => r.decision === "WARN").length,
        PAUSE: paused.length,
      },
      wouldHold: paused.filter((r) => r.mode === "shadow").length,
      held: rs.filter((r) => r.held).length,
      labelled: { attack: attacks.length, legitimate: legit.length },
      pausePrecision: rate(
        labelledPauses.filter((r) => r.outcome === "attack").length,
        labelledPauses.length,
      ),
      falseAlarmRate: rate(legit.filter((r) => r.decision === "PAUSE").length, legit.length),
      catchRate: rate(attacks.filter((r) => r.decision === "PAUSE").length, attacks.length),
    };
  });

  const tacticCounts = new Map<string, number>();
  for (const r of rows)
    if (r.decision !== "ALLOW")
      for (const h of fired(r.hits, threshold))
        tacticCounts.set(h.tacticId, (tacticCounts.get(h.tacticId) ?? 0) + 1);
  const topTactics = [...tacticCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([id, count]) => ({ id, name: library.byId.get(id)?.name ?? id, count }));

  const catches = rows
    .filter((r) => r.outcome === "attack")
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map((r) => ({
      requestId: r.id,
      createdAt: new Date(r.created_at).toISOString(),
      actionKind: r.action_kind,
      amount: r.action.amount ?? null,
      currency: r.action.currency ?? null,
      objectIds: r.object_ids,
      decision: r.decision,
      stopped: r.held,
      tactics: fired(r.hits, threshold).map((h) => h.tacticId),
    }));
  const stoppedByCurrency: Record<string, number> = {};
  for (const c of catches)
    if (c.stopped && c.amount !== null) {
      const cur = c.currency ?? "USD";
      stoppedByCurrency[cur] = (stoppedByCurrency[cur] ?? 0) + c.amount;
    }

  const verifyMinutes = (
    await tx.query<{ minutes: number }>(
      `SELECT extract(epoch FROM completed_at - created_at)::float8 / 60 AS minutes FROM verifications
        WHERE kind = 'callback' AND status = 'completed' AND created_at > now() - make_interval(days => $1)`,
      [days],
    )
  ).rows.map((r) => Number(r.minutes));
  const overrides = Number(
    (
      await tx.query<{ n: string }>(
        "SELECT count(*) AS n FROM verifications WHERE status = 'overridden' AND created_at > now() - make_interval(days => $1)",
        [days],
      )
    ).rows[0]?.n ?? 0,
  );

  return {
    days,
    totals: {
      checks: rows.length,
      paused: rows.filter((r) => r.decision === "PAUSE").length,
      confirmedAttacks: catches.length,
      stoppedAttacks: catches.filter((c) => c.stopped).length,
      stoppedByCurrency,
      medianVerifyMinutes: median(verifyMinutes),
      overrides,
    },
    workflows,
    topTactics,
    catches: catches.slice(0, 50),
  };
}

export interface ListFilters {
  decision?: Decision;
  status?: string;
  mode?: "shadow" | "enforce";
  limit: number;
  before?: string;
}

export async function listRequests(tx: Db, library: TacticLibrary, f: ListFilters) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (f.decision) add("la.decision = ?", f.decision);
  if (f.status) add("r.status = ?", f.status);
  if (f.mode) add("la.mode = ?", f.mode);
  if (f.before) add("r.created_at < ?::timestamptz", f.before);
  params.push(f.limit);
  const rows = (
    await tx.query<
      Row & { v_kind: string | null; v_status: string | null; v_outcome: string | null }
    >(
      `SELECT r.id, r.action, r.action_kind, r.object_ids, r.status, r.created_at,
              la.decision, la.mode, la.held, la.hits, lv.outcome, lv.kind AS label_kind,
              vv.kind AS v_kind, vv.status AS v_status, vv.outcome AS v_outcome
       ${LATEST}
       LEFT JOIN LATERAL (SELECT kind, status, outcome FROM verifications v
                           WHERE v.request_id = r.id ORDER BY v.created_at DESC LIMIT 1) vv ON true
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY r.created_at DESC, r.id
       LIMIT $${params.length}`,
      params,
    )
  ).rows;
  const threshold = library.manifest.fire_threshold;
  return rows.map((r) => ({
    id: r.id,
    createdAt: new Date(r.created_at).toISOString(),
    action: r.action,
    objectIds: r.object_ids,
    status: r.status,
    decision: r.decision,
    mode: r.mode,
    held: r.held,
    tactics: fired(r.hits, threshold).map((h) => h.tacticId),
    label: r.outcome,
    verification: r.v_kind ? { kind: r.v_kind, status: r.v_status, outcome: r.v_outcome } : null,
  }));
}
