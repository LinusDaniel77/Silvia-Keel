import { withTenant, type Db } from "@shield/db";
import { loadCorpus, type CorpusItem } from "@shield/eval";
import type { TacticLibrary } from "@shield/tactics";
import {
  checkApproval,
  completeVerification,
  ingestArtifact,
  reviewRequest,
  setWorkflowMode,
  upsertContacts,
} from "./service.ts";

/**
 * Demo data for partner walk-throughs: synthetic eval-corpus requests run through the real gate.
 * Vendor bank changes are in enforce mode (held, then verified); everything else is in shadow
 * mode and reviewed afterwards, as a security team would. Every label comes from the corpus,
 * so the console's accuracy numbers are the engine's real behavior on synthetic data.
 */
export async function seedDemo(db: Db, tenantId: string, library: TacticLibrary) {
  const actor = "demo-reviewer";
  const corpus = loadCorpus().filter((i) => i.request.action.kind !== "none" && !i.pairOf);
  // A deterministic, mixed slice: handwritten cases plus every 6th generated item.
  const items = corpus.filter((i, n) => i.tags.includes("handwritten") || n % 6 === 0).slice(0, 48);

  await withTenant(db, tenantId, async (tx) => {
    await upsertContacts(tx, tenantId, "vendor master (demo)", [
      {
        subjectType: "vendor",
        subjectId: "V-ATLAS-01",
        channel: "phone",
        value: "+1 206 555 0100",
      },
      { subjectType: "role", subjectId: "requester", channel: "phone", value: "+1 206 555 0199" },
    ]);
    await setWorkflowMode(tx, tenantId, "vendor_bank_change", "enforce", actor);
  });

  let n = 0;
  for (const item of items) {
    n++;
    await withTenant(db, tenantId, (tx) => seedOne(tx, tenantId, library, item, n, actor));
  }
  return { requests: items.length };
}

async function seedOne(
  tx: Db,
  tenantId: string,
  library: TacticLibrary,
  item: CorpusItem,
  n: number,
  actor: string,
) {
  const objectId = `DEMO-${String(n).padStart(3, "0")}`;
  for (const { id: _id, ...artifact } of item.request.artifacts)
    await ingestArtifact(tx, tenantId, artifact, { objectIds: [objectId] });
  const check = await checkApproval(
    tx,
    tenantId,
    {
      action: item.request.action,
      objectIds: [objectId],
      subject:
        item.request.action.kind === "vendor_bank_change"
          ? { type: "vendor", id: "V-ATLAS-01", name: "Atlas Freight" }
          : { type: "role", id: "requester" },
      artifacts: [],
    },
    { library },
  );
  const outcome = item.labels.attack ? "attack" : "legitimate";
  if (check.verification) {
    await completeVerification(
      tx,
      tenantId,
      check.verification.id,
      { outcome, channelUsed: "phone" },
      actor,
    );
  } else if (n % 5 !== 0) {
    // Reviewers label most, not all, shadow-mode requests.
    await reviewRequest(tx, tenantId, check.requestId, outcome, actor);
  }
}
