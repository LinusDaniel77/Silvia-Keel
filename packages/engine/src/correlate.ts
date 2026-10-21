import type { ActionKind } from "@shield/shared";

/**
 * Links an incoming artifact or approval to the request it belongs to. An email asking for a new
 * bank account, the "confirming" call and the vendor bank-change approval are one request; the
 * channel-switch tactic can only be seen once they are joined.
 *
 * Callers pass only the tenant's own open requests (row-level security already guarantees that).
 */
export interface CorrelationCandidate {
  id: string;
  objectIds: string[];
  /** Subjects and bodies of the request's artifacts so far. */
  text: string;
  actionKind: ActionKind;
  claimedRequester: string | null;
  createdAt: Date;
}

export interface CorrelationInput {
  objectIds: string[];
  text: string;
  actionKind: ActionKind;
  claimedRequester: string | null;
  at: Date;
}

export const OBJECT_WINDOW_DAYS = 14;
export const REQUESTER_WINDOW_HOURS = 48;
/** Ids shorter than this ("12", "AP") are too likely to appear by coincidence. */
const MIN_ID_LENGTH = 4;

const DAY = 86_400_000;
const norm = (s: string) => s.trim().toLowerCase();
const mentions = (text: string, id: string) =>
  id.length >= MIN_ID_LENGTH &&
  new RegExp(`(?<![\\w-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(text);

export type CorrelationRule = "object_id" | "object_id_in_text" | "requester_and_action";

/**
 * Rules, strongest first: (1) a shared object id within 14 days; (2) one side's object id written
 * in the other's text within 14 days; (3) the same claimed requester asking for the same kind of
 * action within 48 hours. The most recent candidate wins within a rule. No match: a new request.
 */
export function correlate(
  input: CorrelationInput,
  candidates: CorrelationCandidate[],
): { id: string; rule: CorrelationRule } | null {
  const recent = (c: CorrelationCandidate, ms: number) => {
    const age = input.at.getTime() - c.createdAt.getTime();
    return age >= -60_000 && age <= ms;
  };
  const newestFirst = [...candidates].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const ids = input.objectIds.map(norm).filter((id) => id.length >= MIN_ID_LENGTH);

  for (const c of newestFirst) {
    if (!recent(c, OBJECT_WINDOW_DAYS * DAY)) continue;
    if (c.objectIds.map(norm).some((id) => ids.includes(id)))
      return { id: c.id, rule: "object_id" };
  }
  for (const c of newestFirst) {
    if (!recent(c, OBJECT_WINDOW_DAYS * DAY)) continue;
    if (
      ids.some((id) => mentions(c.text, id)) ||
      c.objectIds.some((id) => mentions(input.text, norm(id)))
    )
      return { id: c.id, rule: "object_id_in_text" };
  }
  if (input.claimedRequester && input.actionKind !== "none") {
    for (const c of newestFirst) {
      if (!recent(c, REQUESTER_WINDOW_HOURS * 3_600_000)) continue;
      if (
        c.claimedRequester &&
        norm(c.claimedRequester) === norm(input.claimedRequester) &&
        c.actionKind === input.actionKind
      )
        return { id: c.id, rule: "requester_and_action" };
    }
  }
  return null;
}
