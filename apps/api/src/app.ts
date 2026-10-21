import { tenantForApiKey, withTenant, type Db } from "@shield/db";
import { parseEml } from "@shield/engine";
import type { LlmProvider } from "@shield/llm";
import { ActionKindSchema, ActionSchema, ArtifactSchema, DecisionSchema } from "@shield/shared";
import type { TacticLibrary } from "@shield/tactics";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { listRequests, summary } from "./reports.ts";
import {
  checkApproval,
  completeVerification,
  Conflict,
  exportLabels,
  getRequest,
  ingestArtifact,
  NotFound,
  overrideVerification,
  reviewRequest,
  setWorkflowMode,
  upsertContacts,
  type NewArtifact,
} from "./service.ts";

const NewArtifactSchema = z
  .object({
    rawEmail: z.string().max(200_000).optional(),
    artifact: ArtifactSchema.omit({ id: true }).optional(),
  })
  .refine(
    (b) => Boolean(b.rawEmail) !== Boolean(b.artifact),
    "send exactly one of rawEmail or artifact",
  );

const toArtifact = (b: z.infer<typeof NewArtifactSchema>): NewArtifact => {
  if (b.artifact) return b.artifact;
  const { id: _id, ...parsed } = parseEml(b.rawEmail!);
  return parsed;
};

const HintsSchema = z
  .object({
    objectIds: z.array(z.string().min(1)).default([]),
    claimedRequester: z.string().optional(),
    actionKind: ActionKindSchema.optional(),
  })
  .default({});

const ArtifactBody = NewArtifactSchema.and(z.object({ correlation: HintsSchema }));

const ApprovalBody = z.object({
  action: ActionSchema.refine(
    (a) => a.kind !== "none",
    "action.kind must name the action being approved",
  ),
  objectIds: z
    .array(z.string().min(1))
    .min(1, "give at least one object id (vendor, payment or invoice id)"),
  claimedRequester: z.string().optional(),
  subject: z.object({
    type: z.enum(["vendor", "role"]),
    id: z.string().min(1),
    name: z.string().optional(),
  }),
  artifacts: z.array(NewArtifactSchema).default([]),
});

const CompleteBody = z.object({
  outcome: z.enum(["legitimate", "attack", "inconclusive"]),
  channelUsed: z.string().min(1),
});
const OverrideBody = z.object({
  reason: z.string().trim().min(10, "an override needs a reason of at least 10 characters"),
});
const ContactsBody = z.object({
  source: z.string().min(1),
  contacts: z
    .array(
      z.object({
        subjectType: z.enum(["vendor", "role"]),
        subjectId: z.string().min(1),
        channel: z.enum(["phone", "email"]),
        value: z.string().min(3),
      }),
    )
    .max(10_000),
});
const WorkflowBody = z.object({ mode: z.enum(["shadow", "enforce"]) });
const ReviewBody = z.object({ outcome: z.enum(["legitimate", "attack", "inconclusive"]) });
const ListQuery = z.object({
  decision: DecisionSchema.optional(),
  status: z.enum(["open", "held", "released", "blocked"]).optional(),
  mode: z.enum(["shadow", "enforce"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().datetime({ offset: true }).optional(),
});
const SummaryQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

/** The console: static files from an allowlist, never a path lookup. */
const CONSOLE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/console");
const CONSOLE_FILES: Record<string, [string, string]> = {
  "/console": ["index.html", "text/html; charset=utf-8"],
  "/console/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/console/styles.css": ["styles.css", "text/css; charset=utf-8"],
};
const CONSOLE_HEADERS = {
  "content-security-policy":
    "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};
const IdParam = z.object({ id: z.string().uuid() });

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const parse = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T => {
  const r = schema.safeParse(value);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new HttpError(400, `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  return r.data;
};

declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
  }
}

/** The person acting (for the audit trail only): an opaque id from the caller's own directory. */
const actorOf = (req: FastifyRequest) => {
  const actor = req.headers["x-shield-actor"];
  if (typeof actor !== "string" || !actor.trim())
    throw new HttpError(400, "x-shield-actor header is required");
  return actor.trim().slice(0, 200);
};

export interface AppDeps {
  db: Db;
  library: TacticLibrary;
  /** Present only when the LLM is explicitly enabled. */
  provider?: LlmProvider;
  /** Marks the console as showing seeded demo data. */
  demo?: boolean;
}

export function buildApp({ db, library, provider, demo = false }: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.decorateRequest("tenantId", "");

  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/v1/")) return;
    const auth = req.headers.authorization ?? "";
    const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const tenantId = key ? await tenantForApiKey(db, key) : null;
    if (!tenantId) throw new HttpError(401, "missing or invalid API key");
    req.tenantId = tenantId;
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
    if (err instanceof NotFound) return reply.status(404).send({ error: err.message });
    if (err instanceof Conflict) return reply.status(409).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
    // Never log request bodies: they may be a customer's real messages.
    console.error(`api: internal error: ${(err as Error).name}`);
    return reply.status(500).send({ error: "internal error" });
  });

  const scoped = <T>(req: FastifyRequest, fn: (tx: Db) => Promise<T>) =>
    withTenant(db, req.tenantId, fn);

  app.get("/healthz", async () => ({
    ok: true,
    demo,
    libraryVersion: library.manifest.version,
    tactics: Object.fromEntries(library.tactics.map((t) => [t.id, t.name])),
  }));

  app.post("/v1/artifacts", async (req, reply) => {
    const body = parse(ArtifactBody, req.body);
    const out = await scoped(req, (tx) =>
      ingestArtifact(tx, req.tenantId, toArtifact(body), body.correlation),
    );
    return reply.status(201).send(out);
  });

  app.post("/v1/approvals/check", async (req) => {
    const body = parse(ApprovalBody, req.body);
    return scoped(req, (tx) =>
      checkApproval(
        tx,
        req.tenantId,
        { ...body, artifacts: body.artifacts.map(toArtifact) },
        { library, provider },
      ),
    );
  });

  app.post("/v1/verifications/:id/complete", async (req) => {
    const { id } = parse(IdParam, req.params);
    const body = parse(CompleteBody, req.body);
    const actor = actorOf(req);
    return scoped(req, (tx) => completeVerification(tx, req.tenantId, id, body, actor));
  });

  app.post("/v1/verifications/:id/override", async (req) => {
    const { id } = parse(IdParam, req.params);
    const { reason } = parse(OverrideBody, req.body);
    const actor = actorOf(req);
    return scoped(req, (tx) => overrideVerification(tx, req.tenantId, id, reason, actor));
  });

  app.put("/v1/known-contacts", async (req) => {
    const body = parse(ContactsBody, req.body);
    return scoped(req, (tx) => upsertContacts(tx, req.tenantId, body.source, body.contacts));
  });

  app.put("/v1/workflows/:actionKind", async (req) => {
    const { actionKind } = parse(z.object({ actionKind: ActionKindSchema }), req.params);
    const { mode } = parse(WorkflowBody, req.body);
    const actor = actorOf(req);
    return scoped(req, (tx) => setWorkflowMode(tx, req.tenantId, actionKind, mode, actor));
  });

  app.get("/v1/requests/:id", async (req) => {
    const { id } = parse(IdParam, req.params);
    return scoped(req, (tx) => getRequest(tx, id));
  });

  for (const [url, [file, type]] of Object.entries(CONSOLE_FILES))
    app.get(url, async (_req, reply) =>
      reply
        .headers(CONSOLE_HEADERS)
        .type(type)
        .send(readFileSync(path.join(CONSOLE_DIR, file), "utf8")),
    );

  app.get("/v1/requests", async (req) => {
    const q = parse(ListQuery, req.query);
    return scoped(req, (tx) => listRequests(tx, library, q));
  });

  app.get("/v1/reports/summary", async (req) => {
    const { days } = parse(SummaryQuery, req.query);
    return scoped(req, (tx) => summary(tx, library, days));
  });

  app.post("/v1/requests/:id/review", async (req) => {
    const { id } = parse(IdParam, req.params);
    const { outcome } = parse(ReviewBody, req.body);
    const actor = actorOf(req);
    return scoped(req, (tx) => reviewRequest(tx, req.tenantId, id, outcome, actor));
  });

  app.get("/v1/labels/export", async (req, reply) => {
    const items = await scoped(req, (tx) => exportLabels(tx));
    return reply
      .type("application/x-ndjson")
      .send(items.map((i) => JSON.stringify(i)).join("\n") + (items.length ? "\n" : ""));
  });

  return app;
}
