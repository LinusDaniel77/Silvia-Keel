import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { analyze, parseEml } from "@shield/engine";
import { AnthropicProvider, hasAnthropicCredentials, type LlmProvider } from "@shield/llm";
import { ActionKindSchema, ShieldRequestSchema, type ShieldRequestInput } from "@shield/shared";
import { loadLibrary, type TacticLibrary } from "@shield/tactics";
import { z } from "zod";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, "../public");
const SAMPLES_DIR = path.resolve(HERE, "../../../samples");
export const MAX_BODY_BYTES = 100 * 1024;

/** Static files are an allowlist, never a path lookup, so there is nothing to traverse. */
const STATIC: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
};

/** Demo samples with the context a partner would otherwise type in. */
export const SAMPLES = [
  {
    id: "bec-vendor-change",
    label: "Vendor bank change (attack)",
    file: "bec-vendor-change.eml",
    action: "vendor_bank_change",
    orgDomain: "keelbridge.com",
    knownDomain: "atlasfreight.com",
  },
  {
    id: "legit-urgent-cfo",
    label: "Real CFO, real deadline",
    file: "legit-urgent-cfo.eml",
    action: "payment",
    orgDomain: "keelbridge.com",
    knownDomain: "",
  },
  {
    id: "injection",
    label: "Message that talks to the filter",
    file: "injection.eml",
    action: "payment",
    orgDomain: "keelbridge.com",
    knownDomain: "",
  },
  {
    id: "multi-channel",
    label: "Email, then a confirming call",
    file: "multi-channel.json",
    action: "payment",
    orgDomain: "keelbridge.com",
    knownDomain: "",
  },
] as const;

export const AnalyzeBodySchema = z.object({
  text: z.string().min(1, "paste a message first"),
  action: ActionKindSchema.default("none"),
  amount: z.number().nonnegative().optional(),
  orgDomain: z.string().optional(),
  knownDomain: z.string().optional(),
  useClaude: z.boolean().default(false),
});
export type AnalyzeBody = z.infer<typeof AnalyzeBodySchema>;

const domains = (s?: string) =>
  (s ?? "")
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);

const looksLikeEmail = (text: string) => {
  const head = text.split(/\r?\n\r?\n/, 1)[0] ?? "";
  return (
    /^(from|subject|to|date|reply-to|received|return-path|message-id|mime-version):/im.test(head) &&
    /^from:/im.test(head)
  );
};

/** Turns pasted text into a request: a full JSON request, a raw email, or plain text. */
export function toRequest(body: AnalyzeBody): ShieldRequestInput {
  const text = body.text.trim();
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && "artifacts" in parsed)
        return ShieldRequestSchema.parse(parsed);
    } catch {
      // Not a request object; analyze it as text.
    }
  }
  const artifact = looksLikeEmail(text)
    ? parseEml(text, "pasted")
    : { id: "pasted", channel: "other" as const, body: text };
  return {
    id: "demo",
    action: { kind: body.action, ...(body.amount !== undefined ? { amount: body.amount } : {}) },
    artifacts: [artifact],
    context: { orgDomains: domains(body.orgDomain), knownSenderDomains: domains(body.knownDomain) },
  };
}

function send(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  type = "application/json",
) {
  const body = type === "application/json" ? JSON.stringify(payload) : (payload as string);
  res.writeHead(status, {
    "content-type": type === "application/json" ? "application/json; charset=utf-8" : type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy":
      "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
  });
  res.end(body);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, `request too large (limit ${MAX_BODY_BYTES / 1024} KB)`));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export interface DemoOptions {
  library: TacticLibrary;
  /** Present only when credentials are configured. Pasted text goes to Anthropic only if the user ticks "Use Claude". */
  provider?: LlmProvider;
}

export function createDemoServer({ library, provider }: DemoOptions): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname]!;
        return send(res, 200, readFileSync(path.join(PUBLIC_DIR, file), "utf8"), type);
      }
      if (req.method === "GET" && url.pathname === "/api/config") {
        return send(res, 200, {
          claudeAvailable: Boolean(provider),
          model: provider?.model ?? null,
          libraryVersion: library.manifest.version,
          tactics: Object.fromEntries(
            library.tactics.map((t) => [t.id, { name: t.name, family: t.family }]),
          ),
          combinations: Object.fromEntries(
            library.manifest.critical_combinations.map((c) => [c.id, c.description]),
          ),
          samples: SAMPLES.map((s) => ({
            ...s,
            text: readFileSync(path.join(SAMPLES_DIR, s.file), "utf8"),
          })),
        });
      }
      if (req.method === "POST" && url.pathname === "/api/analyze") {
        let json: unknown;
        try {
          json = JSON.parse(await readBody(req));
        } catch (e) {
          if (e instanceof HttpError) throw e;
          throw new HttpError(400, "body must be JSON");
        }
        const parsed = AnalyzeBodySchema.safeParse(json);
        if (!parsed.success)
          throw new HttpError(400, parsed.error.issues[0]?.message ?? "invalid request");
        let request: ShieldRequestInput;
        try {
          request = toRequest(parsed.data);
        } catch (e) {
          throw new HttpError(
            400,
            e instanceof z.ZodError ? (e.issues[0]?.message ?? "invalid request") : String(e),
          );
        }
        const useClaude = parsed.data.useClaude && Boolean(provider);
        const analysis = await analyze(request, {
          library,
          provider: useClaude ? provider : undefined,
        });
        const normalized = ShieldRequestSchema.parse(request);
        return send(res, 200, { analysis, artifacts: normalized.artifacts, claudeUsed: useClaude });
      }
      throw new HttpError(404, "not found");
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      // Never echo request content into logs: it may be a partner's real incident.
      console.error(
        `demo: internal error on ${req.method} ${url.pathname}: ${e instanceof Error ? e.name : "unknown"}`,
      );
      return send(res, 500, { error: "internal error" });
    }
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      host: { type: "string" },
      "rules-only": { type: "boolean" },
    },
  });
  const host = values.host ?? "127.0.0.1";
  const port = Number(values.port ?? 4173);
  const provider =
    !values["rules-only"] && hasAnthropicCredentials() ? new AnthropicProvider() : undefined;
  const server = createDemoServer({ library: loadLibrary(), provider });
  server.listen(port, host, () => {
    console.log(`Manipulation Shield demo on http://${host}:${port}`);
    console.log(
      provider
        ? `Claude classifier available (${provider.model}); pasted text is sent to Anthropic only when "Use Claude" is ticked.`
        : "Rules only: no Anthropic credentials found (set SHIELD_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY to enable Claude).",
    );
    if (host !== "127.0.0.1" && host !== "localhost")
      console.warn("Warning: listening beyond localhost. This demo has no authentication.");
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void main();
