import { describe, expect, it } from "vitest";
import { correlate, type CorrelationCandidate, type CorrelationInput } from "../src/index.ts";

const now = new Date("2026-10-21T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
const cand = (over: Partial<CorrelationCandidate>): CorrelationCandidate => ({
  id: "r1",
  objectIds: [],
  text: "",
  actionKind: "none",
  claimedRequester: null,
  createdAt: hoursAgo(1),
  ...over,
});
const input = (over: Partial<CorrelationInput>): CorrelationInput => ({
  objectIds: [],
  text: "",
  actionKind: "none",
  claimedRequester: null,
  at: now,
  ...over,
});

describe("correlate", () => {
  it("joins on a shared object id, case-insensitively", () => {
    expect(
      correlate(input({ objectIds: ["V-ATLAS-01"] }), [cand({ objectIds: ["v-atlas-01"] })]),
    ).toEqual({
      id: "r1",
      rule: "object_id",
    });
  });

  it("joins an approval to an earlier email that mentions its invoice", () => {
    const email = cand({ text: "Please remit INV-4471 and INV-4490 to the new account." });
    expect(correlate(input({ objectIds: ["V-ATLAS-01", "INV-4471"] }), [email])).toEqual({
      id: "r1",
      rule: "object_id_in_text",
    });
  });

  it("does not match an id inside a longer one, or ids too short to be meaningful", () => {
    expect(
      correlate(input({ objectIds: ["INV-44"] }), [cand({ text: "see INV-4471" })]),
    ).toBeNull();
    expect(correlate(input({ objectIds: ["AP"] }), [cand({ objectIds: ["AP"] })])).toBeNull();
  });

  it("joins the same requester asking for the same action within 48 hours, and no later", () => {
    const c = cand({ claimedRequester: "Marcus Webb", actionKind: "payment" });
    const i = input({ claimedRequester: "marcus webb", actionKind: "payment" });
    expect(correlate(i, [c])?.rule).toBe("requester_and_action");
    expect(correlate(i, [{ ...c, createdAt: hoursAgo(49) }])).toBeNull();
    expect(correlate({ ...i, actionKind: "credential_reset" }, [c])).toBeNull();
  });

  it("never merges different vendors, and ignores stale requests", () => {
    const atlas = cand({ id: "atlas", objectIds: ["V-ATLAS-01"], text: "Atlas Freight INV-4471" });
    const delta = cand({ id: "delta", objectIds: ["V-DELTA-07"], text: "Delta Metals INV-8812" });
    expect(correlate(input({ objectIds: ["V-DELTA-07"] }), [atlas, delta])?.id).toBe("delta");
    expect(correlate(input({ objectIds: ["V-NEW-99"] }), [atlas, delta])).toBeNull();
    expect(
      correlate(input({ objectIds: ["V-ATLAS-01"] }), [{ ...atlas, createdAt: hoursAgo(15 * 24) }]),
    ).toBeNull();
  });

  it("prefers the most recent of several matches", () => {
    const older = cand({ id: "older", objectIds: ["V-ATLAS-01"], createdAt: hoursAgo(30) });
    const newer = cand({ id: "newer", objectIds: ["V-ATLAS-01"], createdAt: hoursAgo(2) });
    expect(correlate(input({ objectIds: ["V-ATLAS-01"] }), [older, newer])?.id).toBe("newer");
  });
});
