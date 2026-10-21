import type { Artifact } from "@shield/shared";

const QUOTE_MARKERS = [
  /^-{2,}\s*original message\s*-{2,}/i,
  /^on .{3,200}wrote:\s*$/i,
  /^from:\s.+$/i, // Outlook-style forwarded/replied header block
  /^_{10,}$/,
];

/** Splits a reply body into the new text and the quoted history under it. */
export function stripQuoted(body: string): { body: string; quoted?: string } {
  const lines = body.split(/\r?\n/);
  const idx = lines.findIndex(
    (line, i) =>
      line.trimStart().startsWith(">") ||
      (i > 0 && QUOTE_MARKERS.some((re) => re.test(line.trim()))),
  );
  if (idx <= 0) return { body: body.trim() };
  return {
    body: lines.slice(0, idx).join("\n").trim(),
    quoted: lines.slice(idx).join("\n").trim(),
  };
}

function parseHeaders(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  const unfolded = block.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    if (m && m[1] && !headers.has(m[1].toLowerCase())) headers.set(m[1].toLowerCase(), m[2] ?? "");
  }
  return headers;
}

/** Parses `"Name" <addr@x>` or `addr@x`. */
export function parseAddress(value: string | undefined): {
  address?: string;
  displayName?: string;
} {
  if (!value) return {};
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value);
  if (m) {
    const displayName = m[1]?.trim();
    return { address: m[2]?.trim().toLowerCase(), ...(displayName ? { displayName } : {}) };
  }
  return { address: value.trim().toLowerCase() };
}

function decodeQuotedPrintable(s: string): string {
  return s
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeBody(body: string, headers: Map<string, string>): string {
  const encoding = (headers.get("content-transfer-encoding") ?? "").toLowerCase();
  if (encoding === "base64")
    return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  if (encoding === "quoted-printable") return decodeQuotedPrintable(body);
  return body;
}

function splitHead(raw: string): [string, string] {
  const m = /\r?\n\r?\n/.exec(raw);
  return m ? [raw.slice(0, m.index), raw.slice(m.index + m[0].length)] : [raw, ""];
}

/** Extracts the text/plain body, descending into multipart containers. */
function extractText(headers: Map<string, string>, body: string): string {
  const type = headers.get("content-type") ?? "text/plain";
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  if (/^multipart\//i.test(type) && boundary) {
    const parts = body.split(`--${boundary}`).slice(1);
    for (const part of parts) {
      if (part.startsWith("--")) break;
      const [head, partBody] = splitHead(part.replace(/^\r?\n/, ""));
      const text = extractText(parseHeaders(head), partBody);
      if (text) return text;
    }
    return "";
  }
  if (/^text\/plain/i.test(type) || !headers.has("content-type")) return decodeBody(body, headers);
  return "";
}

/** Minimal RFC 5322 parser: enough for headers that matter and a plain-text body. */
export function parseEml(raw: string, id = "eml-1"): Artifact {
  const [head, rest] = splitHead(raw);
  const headers = parseHeaders(head);
  const { body, quoted } = stripQuoted(extractText(headers, rest));
  const date = headers.get("date");
  const parsedDate = date ? new Date(date) : undefined;
  const replyTo = parseAddress(headers.get("reply-to")).address;
  return {
    id,
    channel: "email",
    sender: parseAddress(headers.get("from")),
    ...(replyTo ? { replyTo } : {}),
    ...(headers.get("subject") ? { subject: headers.get("subject") } : {}),
    ...(parsedDate && !Number.isNaN(parsedDate.getTime())
      ? { receivedAt: parsedDate.toISOString() }
      : {}),
    body,
    ...(quoted ? { quoted } : {}),
  };
}

/** The text the engine and the classifier read: subjects and new bodies, never quoted history. */
export function analysisText(artifacts: Artifact[]): string {
  return artifacts.map((a) => [a.subject, a.body].filter(Boolean).join("\n")).join("\n\n");
}
